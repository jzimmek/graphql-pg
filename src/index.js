import {Buffer} from "buffer"
import gql from "graphql-tag"
import {GraphQLObjectType,GraphQLList} from "graphql"
import {getVariableValues,getArgumentValues} from "graphql/execution/values"
import {isCompositeType,isAbstractType,isLeafType,getNullableType,getNamedType} from "graphql/type/definition"
import {printSchema} from "graphql/utilities/schemaPrinter"
import snakeCase from "lodash/fp/snakeCase"

import merge, {SPLIT} from "./merge"
import toExecutableSqlAndParams from "./toExecutableSqlAndParams"

function selectionInfo({typeAst, typeName, selection, idx=""}){
  const fieldDefinitionAst = typeAst.fields.find(e => e.name.value === selection.name.value)

  if(!fieldDefinitionAst)
    throw new Error(`field not found: ${selection.name.value} on type: ${typeName}`)

  return {
    columnName: selection.name.value === "__typename" ? selection.name.value : snakeCase(selection.name.value),
    columnNameAs: (selection.alias ? selection.alias.value : selection.name.value) + (idx ? `${SPLIT}${idx}` : ""),
    fieldDefinitionAst,
    selection,
  }
}

function getArgs({transpileInfo: ti, selectionInfo: si}){
  const variableValues = getVariableValues(ti.schema, ti.queryDefinitionsAst[0], ti.variableValues),
        field = ti.schema.getType(ti.typeName).getFields()[si.selection.name.value],
        argumentValues = getArgumentValues(field, si.selection, ti.variableValues)

  return {...variableValues, ...argumentValues}
}

function transpileScalar({transpileInfo: ti, selectionInfo: si}){
  const contextValue = {...ti.contextValue, table: `"${ti.table}"`},
        select = ti.selects[ti.typeName] && ti.selects[ti.typeName][si.selection.name.value]

  const sqlParts = select ? select(
    getArgs({transpileInfo: ti, selectionInfo: si}),
    contextValue
  ) : [`"${ti.table}"."${si.columnName}"`]

  return append({
    sql: [
      sqlParts[0],
      ...sqlParts.slice(1),
      ` as "${si.columnNameAs}"`
    ],
  })
}

function transpileInJsonFunc({transpileInfo: ti, selectionInfo: si}, inner){
  const {typeName} = ti,
        field = ti.schema.getType(typeName).getFields()[si.selection.name.value],
        isObject = getNullableType(field.type) instanceof GraphQLObjectType,
        isList = getNullableType(field.type) instanceof GraphQLList,
        json_func = isObject ? "to_json" : (isList ? "json_agg" : new Error("neither list nor object type"))

  if(typeName === "Query" || typeName === "Mutation"){
    return append({
      sql: [
        `(select ${json_func}(y) from (`,
        inner,
        `) as y) as "${si.columnNameAs}"`,
      ],
    })
  } else {
    return append({
      joins: [
        `left join lateral (select ${json_func}(x) from (`,
        inner,
        `) as x) as "${si.columnNameAs}" on true\n`
      ],
      sql: [
        ...(isObject ? [`"${si.columnNameAs}".${json_func} as "${si.columnNameAs}"`] : []),
        ...(isList ? [`coalesce("${si.columnNameAs}".${json_func}, '[]') as "${si.columnNameAs}"`] : []),
      ]
    })
  }
}

function transpileObjectAndList({transpileInfo: ti, selectionInfo: si}){

  const field = ti.schema.getType(ti.typeName).getFields()[si.selection.name.value],
        isObject = getNullableType(field.type) instanceof GraphQLObjectType

  const contextValue = {...ti.contextValue, table: `"${ti.table}"`},
        select = ti.selects[ti.typeName] && ti.selects[ti.typeName][si.selection.name.value],
        sqlParts = select ? select(
          getArgs({transpileInfo: ti, selectionInfo: si}),
          contextValue
        ) : (isObject ? null : [])

  // TODO: handle non sql (!select) properly

  if(Array.isArray(sqlParts)){
    const inner = transpile({
      ...ti,
      queryAst: si.selection,
      typeName: getNamedType(field.type).name,
      table: si.columnNameAs,
      from: [
        sqlParts[0],
        ...sqlParts.slice(1)
      ]
    })

    return transpileInJsonFunc({transpileInfo: ti, selectionInfo: si}, inner)

  }else if(typeof(sqlParts) === "object"){

    if(sqlParts.kind === "cursor"){
      return append({
        sql: [
          `(select x.* from (`,
          sqlParts.sql[0],
          ...sqlParts.sql.slice(1),
          `) x) as "${si.columnNameAs}"`,
        ]
      })
    }else{

      // union

      const jsonFunc = getNullableType(field.type) instanceof GraphQLList ? "json_agg" : "to_json"

      let inner = Object.keys(sqlParts.types).reduce((memo,typeName,idx,arr) => {

        const sqlParts2 = sqlParts.types[typeName],
              inner2 = transpile({
                ...ti,
                queryAst: si.selection,
                typeName: typeName,
                table: si.columnNameAs,
                from: [
                  sqlParts2[0],
                  ...sqlParts2.slice(1)
                ]
              })

        return [
          ...memo,
          [`(select (cast('{"type":"${typeName}"}' as jsonb) || cast(to_json(x.*) as jsonb)) as to_json from (`, inner2,`) as x)`],
          ...((idx < arr.length - 1) ? ["union all"] : [])
        ]
      }, [])

      if(sqlParts.wrapper)
        inner = sqlParts.wrapper(inner)

      return append({
        sql: [`(select ${jsonFunc}(y.to_json) from (`,inner,`) as y) as "${si.columnNameAs}"`],
      })
    }


  }else{
    throw new Error(`no sql return value of ${ti.typeName}.${si.selection.name.value}`)
  }
}

function transpileSelection({transpileInfo:ti,selectionInfo:si}){
  const field = ti.schema.getType(ti.typeName).getFields()[si.selection.name.value],
        isLeaf = isLeafType(getNamedType(field.type))

  if((ti.typeName==="Query" || ti.typeName==="Mutation") && isLeaf){
    throw new Error(`scalar: ${si.selection.name.value} not supported on type: ${ti.typeName}`)
  }

  if(isLeaf){
    return transpileScalar({transpileInfo: ti, selectionInfo: si})
  }else if(isCompositeType(getNamedType(field.type))){
    return transpileObjectAndList({transpileInfo: ti, selectionInfo: si})
  }

  return append()
}

function onlyNonSchemaSelections(){
  return (selection) => {
    return !selection.name || selection.name.value !== "__schema"
  }
}

function onlySelectionsForSqlFields(selects, typeAst, typeName, schema){
  return (selection) => {
    if(selection.kind === "Field"){

      if(selection.name.value === "__typename")
        return true

      if(selects[typeName] && selects[typeName][selection.name.value])
        return true

      const field = schema.getType(typeName).getFields()[selection.name.value]

      if(isLeafType(getNamedType(field.type)))
        return isSqlField(selects, typeName, field.name)
    }

    return true
  }
}

function isSqlField(selects, typeName, fieldName){
  if(!selects.hasOwnProperty(typeName) || !selects[typeName].hasOwnProperty(fieldName))
    return true

  return !!selects[typeName][fieldName]
}

function appendSelectionForIdField(typeName){
  return (memo,selection,idx,arr) => {
    return [
      ...memo,
      selection,
      ...(!["Query","Mutation"].includes(typeName) && !typeName.match(/Connection$/) && idx === arr.length -1 ? [
        {
          kind: "Field",
          name: {value: "id"},
          directives: [],
          arguments: [],
          selectionSet: null,
        }
      ] : [])
    ]
  }
}

function append({sql=[],joins=[]}={}, {sql:sql2=[],joins:joins2=[]}={}){
  return {
    sql: [...sql, ...sql2],
    joins: [...joins, ...joins2],
  }
}

function transpileFragmentSelections(selections, typeName, typeAst, idx, transpileInfo){
  let out = append()

  selections.forEach((selection2,idx2,arr2) => {
    if(selection2.kind === "Field" && selection2.name.value === "__typename"){
      out = append(out, {sql: [`'${typeName}' as "__typename"`]})
    }else if(["InlineFragment","FragmentSpread"].includes(selection2.kind)){

      const {selectionSet:{selections:selections3}} = (selection2.kind === "InlineFragment")
        ? selection2
        : transpileInfo
            .queryDefinitionsAst
            .find(e => e.kind === "FragmentDefinition" && e.name.value === selection2.name.value)

      out = append(out, transpileFragmentSelections(selections3, typeName, typeAst, idx, transpileInfo))

    }else{
      const si = selectionInfo({typeAst,typeName,selection:selection2,idx:`${idx}`})
      out = append(out, transpileSelection({transpileInfo, selectionInfo: si}))
    }

    if(idx2 < arr2.length - 1)
      out = append(out, {sql: [","]})
  })

  return out
}

function onlyMatchingFragmentTypeCondition(schema, typeName, queryDefinitionsAst){
  return (selection) => {
    if(selection.kind === "InlineFragment" || selection.kind === "FragmentSpread"){
      const {typeCondition} = selection.kind === "FragmentSpread"
        ? queryDefinitionsAst.find(e => e.kind === "FragmentDefinition" && e.name.value === selection.name.value)
        : selection

      const maybeAbstractType = schema.getType(typeCondition.name.value),
            possibleType = schema.getType(typeName)

      return isAbstractType(maybeAbstractType)
        ? schema.isPossibleType(maybeAbstractType, possibleType)
        : maybeAbstractType === possibleType
    }

    return true
  }
}

function transpile(transpileInfo){
  const {selects, schema, queryAst, queryDefinitionsAst, schemaAst, typeName, from, table} = transpileInfo,
        {selectionSet} = queryAst,
        typeAst = schemaAst.definitions.find(e => e.kind === "ObjectTypeDefinition" && e.name.value === typeName)

  let out = append({sql: ["select "]})

  const selections = selectionSet.selections
    .reduce(appendSelectionForIdField(typeName), [])
    .filter(onlyNonSchemaSelections())
    .filter(onlyMatchingFragmentTypeCondition(schema, typeName, queryDefinitionsAst))
    .filter(onlySelectionsForSqlFields(selects, typeAst, typeName, schema))

  if(!selections.length)
    return []

  selections.forEach((selection,idx,arr) => {
    if(selection.kind === "FragmentSpread"){
      const fragmentAst = queryDefinitionsAst.find(e => e.kind === "FragmentDefinition" && e.name.value === selection.name.value)
      out = append(out, transpileFragmentSelections(fragmentAst.selectionSet.selections, typeName, typeAst, idx, transpileInfo))
    }else if(selection.kind === "InlineFragment") {
      out = append(out, transpileFragmentSelections(selection.selectionSet.selections, typeName, typeAst, idx, transpileInfo))
    }else if(selection.kind === "Field") {
      const selection2 = selection

      if(selection2.name.value === "__typename"){
        out = append(out, {sql: [`'${typeName}' as "__typename"`]})
      }else{
        const si = selectionInfo({typeAst,typeName,selection:selection2})
        out = append(out, transpileSelection({transpileInfo, selectionInfo: si}))
      }
    }

    if(idx < arr.length - 1)
      out = append(out, {sql: [","]})
  })

  if(from)
    out = append(out, {sql: [`from (`, from, `) as "${table}"`]})

  return [...out.sql, ...out.joins]
}

function sqlResolve({execQuery, schema, selects, queryStr, contextValue={}, variables={}, log, dbMerge}){
  return (typeName) => {
    const info = gql`${queryStr}`

    const sqlArr = transpile({
      selects,
      queryAst: info.definitions[0],
      queryDefinitionsAst: info.definitions,
      schemaAst: gql`${printSchema(schema)}`,
      schema,
      typeName,
      contextValue,
      variableValues: variables,
    })

    if(!sqlArr.length)
      return {}

    let {sql,params} = toExecutableSqlAndParams(sqlArr)

    if(dbMerge)
      sql = `select graphql_pg_merge(cast(to_json(t) as jsonb)) as to_json from (${sql}) t`

    if(log)
      log(sql, params)

    // console.info(">>>>>>>>> sql >>>>>>>>>\n", sql)
    // console.info(">>>>>>>>> params >>>>>>\n", params)

    return execQuery(sql, params).then((result) => {
      const [row] = result.rows,
            mutationResultKey = info.definitions[0].selectionSet.selections[0].name.value,
            res = (typeName === "Mutation") ? (dbMerge ? {to_json: row.to_json[mutationResultKey]} : row[mutationResultKey]) : row

      // console.info("==== raw ======\n", JSON.stringify(res,null,2))

      if(dbMerge)
        return res.to_json

      const mergedRes = Array.isArray(res) ? merge({entries:res}, {entries:res}).entries : merge(res, res)

      // console.info("==== merged ======\n", JSON.stringify(mergedRes,null,2))

      return mergedRes
    })
  }
}

function aliasAwareResolve(origResolve){
  return (obj,args,ctx,info) => {
    let ast = info.fieldNodes[0],
        key = ast.alias ? ast.alias.value : ast.name.value

    if(obj[key] === undefined && origResolve)
      return origResolve(obj,args,ctx,info)

    return obj[key]
  }
}

export function makeResolverAliasAware(schema){
  Object.keys(schema.getTypeMap()).forEach(typeName => {
    const type = schema.getType(typeName)

    if(typeName.match(/^__/))
      return

    if(isCompositeType(type) && type.getFields){
      Object.keys(type.getFields()).forEach(fieldName => {
        const field = type.getFields()[fieldName]
        field.resolve = aliasAwareResolve(field.resolve)
      })
    }
  })
}

export function createRootResolve({execQuery, schema, selects, contextValue={}, query, variables, log, dbMerge}){
  const clientAst = gql`${query}`,
        {definitions:[{operation}]} = clientAst,
        resolve = sqlResolve({execQuery, schema, selects, queryStr: clientAst, contextValue, variables, log, dbMerge})

  return (operation === "mutation") ? Promise.resolve(({sqlResolve: () => resolve("Mutation")})) : resolve("Query")
}

export function sql(...args){
  let [parts,...vars] = args

  return parts.reduce((memo, part, idx) => {
    if(part.length === 0)
      return memo

    let nextMemo = memo.concat(part)

    if(idx < vars.length){
      let varValue = vars[idx]

      if(varValue && varValue.hasOwnProperty("__raw")){
        nextMemo = nextMemo.concat(varValue.__raw)
      }else{
        nextMemo = nextMemo.concat({__param: varValue === undefined ? null : varValue})
      }
    }

    return nextMemo
  }, [])
}

sql.raw = (val) => ({__raw: val})

export function cursor({before,after,first,last}, fn){
  after = after ? JSON.parse(Buffer.from(after, "base64").toString("utf8")) : []
  before = before ? JSON.parse(Buffer.from(before, "base64").toString("utf8")) : []

  const limit = Math.max(first||0,last||0) || 10,
        subSql = fn(before, after),
        withSql = sql`
          with query as (
            ${sql.raw(subSql)}
          ), limited_query as (
            select * from query order by "$row_number" ${sql.raw(first ? "asc" : "desc")} limit ${limit}
          ), ordered_query as (
            select * from limited_query order by "$row_number" asc
          ), edges as (
            select
              json_build_object(
                -- merge array expects an id
                'id',
                encode(cast(cast("$cursor" as text) as bytea),'base64'),
                'cursor',
                encode(cast(cast("$cursor" as text) as bytea),'base64'),
                'node',
                cast(to_json(q) as jsonb) - '$cursor' - '$row_number'
              )
            from ordered_query q
          ), connection as (
            select json_build_object(
              'edges',
              coalesce((select json_agg(e.json_build_object) from edges e), cast('[]' as json)),
              'pageInfo',
              json_build_object(
                'hasPreviousPage',
                coalesce((select count(1) > cast(${last} as integer) from query), false),
                'hasNextPage',
                coalesce((select count(1) > cast(${first} as integer) from query), false)
              )
            )
          )
          select json_build_object from connection
        `

  return {
    kind: "cursor",
    sql: withSql,
  }
}
