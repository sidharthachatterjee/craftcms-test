// import compress from "graphql-query-compress"
const {
  makeRemoteExecutableSchema,
  transformSchema,
  introspectSchema,
  RenameTypes,
} = require(`graphql-tools`)

const transformFragments = ({
  possibleTypes,
  gatsbyNodesInfo,
  typeMap,
  depth,
  maxDepth,
}) =>
  possibleTypes && depth <= maxDepth
    ? possibleTypes
        .map(possibleType => {
          const type = typeMap.get(possibleType.name)

          if (!type) {
            return false
          }

          // save this type so we can use it in schema customization
          store.dispatch.remoteSchema.addFetchedType(type)

          const isAGatsbyNode = gatsbyNodesInfo.typeNames.includes(
            possibleType.name
          )

          if (isAGatsbyNode) {
            // we use the id to link to the top level Gatsby node
            possibleType.fields = [`id`]
            return possibleType
          }

          const typeInfo = typeMap.get(possibleType.name)

          if (typeInfo) {
            const fields = recursivelyTransformFields({
              fields: typeInfo.fields,
              depth,
            })

            if (!fields || !fields.length) {
              return false
            }

            possibleType.fields = fields
            return possibleType
          }

          return false
        })
        .filter(Boolean)
    : null

function transformField({
  field,
  gatsbyNodesInfo,
  typeMap,
  maxDepth,
  depth,
  fieldBlacklist,
  fieldAliases,
} = {}) {
  // we're potentially infinitely recursing when fields are connected to other types that have fields that are connections to other types
  //  so we need a maximum limit for that
  if (depth >= maxDepth) {
    return false
  }

  depth++

  // if the field has no type we can't use it.
  if (!field || !field.type) {
    return false
  }

  const typeSettings = getTypeSettingsByType(field.type)

  if (typeSettings.exclude || typeSettings.nodeInterface) {
    return false
  }

  // this is used to alias fields that conflict with Gatsby node fields
  // for ex Gatsby and WPGQL both have a `parent` field
  const fieldName =
    fieldAliases && fieldAliases[field.name]
      ? `${fieldAliases[field.name]}: ${field.name}`
      : field.name

  if (
    fieldBlacklist.includes(field.name) ||
    fieldBlacklist.includes(fieldName)
  ) {
    return false
  }

  // remove fields that have required args. They'll cause query errors if ommitted
  //  and we can't determine how to use those args programatically.
  if (
    field.args &&
    field.args.length &&
    field.args.find(arg => arg && arg.type && arg.type.kind === `NON_NULL`)
  ) {
    return false
  }

  const fieldType = field.type || {}
  const ofType = fieldType.ofType || {}

  if (
    fieldType.kind === `SCALAR` ||
    (fieldType.kind === `NON_NULL` && ofType.kind === `SCALAR`) ||
    (fieldType.kind === `LIST` && fieldType.ofType.kind === `SCALAR`)
  ) {
    return fieldName
  }

  const isListOfGatsbyNodes =
    ofType && gatsbyNodesInfo.typeNames.includes(ofType.name)

  if (fieldType.kind === `LIST` && isListOfGatsbyNodes) {
    return {
      fieldName: fieldName,
      fields: [`id`],
    }
  } else if (fieldType.kind === `LIST`) {
    const listOfType = typeMap.get(ofType.name)

    const transformedFields = recursivelyTransformFields({
      fields: listOfType.fields,
      depth,
    })

    const transformedFragments = transformFragments({
      possibleTypes: listOfType.possibleTypes,
      gatsbyNodesInfo,
      typeMap,
      depth,
      maxDepth,
    })

    if (
      !transformedFields &&
      transformedFragments &&
      !transformedFragments.length
    ) {
      return false
    }

    if (
      !transformedFragments &&
      transformedFields &&
      !transformedFields.length
    ) {
      return false
    }

    // if we have either fragments or fields
    return {
      fieldName: fieldName,
      fields: transformedFields,
      fragments: transformedFragments,
    }
  }

  const isAGatsbyNode = gatsbyNodesInfo.typeNames.includes(fieldType.name)
  const isAMediaItemNode = isAGatsbyNode && fieldType.name === `MediaItem`

  // pull the id and sourceUrl for connections to media item gatsby nodes
  if (isAMediaItemNode) {
    return {
      fieldName: fieldName,
      fields: [`id`, `sourceUrl`],
    }
  } else if (isAGatsbyNode) {
    // just pull the id for connections to other gatsby nodes
    return {
      fieldName: fieldName,
      fields: [`id`],
    }
  }

  const typeInfo = typeMap.get(fieldType.name)

  const { fields } = typeInfo || {}

  if (fields) {
    const transformedFields = recursivelyTransformFields({
      fields,
      depth,
    })

    if (!transformedFields || !transformedFields.length) {
      return false
    }

    return {
      fieldName: fieldName,
      fields: transformedFields,
    }
  }

  if (fieldType.kind === `UNION`) {
    const typeInfo = typeMap.get(fieldType.name)

    const transformedFields = recursivelyTransformFields({
      fields: typeInfo.fields,
      depth,
    })

    const fragments = transformFragments({
      possibleTypes: typeInfo.possibleTypes,
      gatsbyNodesInfo,
      typeMap,
      depth,
      maxDepth,
    })

    return {
      fieldName: fieldName,
      fields: transformedFields,
      fragments,
    }
  }

  return false
}

const recursivelyTransformFields = ({ fields, depth = 0 }) => {
  const {
    gatsbyApi: {
      pluginOptions: {
        schema: { queryDepth },
      },
    },
    remoteSchema: { fieldBlacklist, fieldAliases, typeMap, gatsbyNodesInfo },
  } = store.getState()

  if (depth >= queryDepth) {
    return null
  }

  return fields
    ? fields
        .map(field => {
          const transformedField = transformField({
            maxDepth: queryDepth,
            gatsbyNodesInfo,
            fieldBlacklist,
            fieldAliases,
            typeMap,
            field,
            depth,
          })

          if (transformedField) {
            // save this type so we know to use it in schema customization
            store.dispatch.remoteSchema.addFetchedType(field.type)
          }

          return transformedField
        })
        .filter(Boolean)
    : null
}

const buildNodesQueryOnFieldName = ({ fields, fieldName, postTypes }) =>
  // compress(
  buildQuery({
    queryName: `NODE_LIST_QUERY`,
    variables: `$first: Int!, $after: String`,
    fieldName,
    // fieldVariables: `first: $first, after: $after ${
    //   postTypes.length &&
    //   // this is temporary until we can get a flat list of posts
    //   // https://github.com/wp-graphql/wp-graphql/issues/928
    //   postTypes.map(postType => postType.fieldNames.plural).includes(fieldName)
    //     ? `, where: { parent: null }`
    //     : ``
    // }`,
    // fields: [
    //   {
    //     fieldName: `pageInfo`,
    //     fields: [`hasNextPage`, `endCursor`],
    //   },
    //   {
    //     fieldName: `nodes`,
    //     fields: fields,
    //   },
    // ],
  })
// )

const buildVariables = variables =>
  variables && typeof variables === `string` ? `(${variables})` : ``

const buildFragment = ({ name, fields }) => `
  ... on ${name} {
    ${buildSelectionSet(fields)}
  }
`

const buildFragments = fragments => `
  __typename
  ${fragments.map(buildFragment).join(` `)}
`

const buildSelectionSet = fields => {
  if (!fields || !fields.length) {
    return ``
  }

  return fields
    .map(field => {
      if (typeof field === `string`) {
        return field
      }

      const { fieldName, variables, fields, fragments } = field

      if (fieldName && fragments) {
        return `
          ${fieldName} {
            ${buildFragments(fragments)}
          }
        `
      }

      if (fieldName && fields) {
        return `
            ${fieldName} ${buildVariables(variables)} {
              ${buildSelectionSet(fields)}
            }
          `
      }

      return null
    })
    .filter(Boolean).join(`
    `)
}

const buildQuery = ({
  queryName,
  fieldName,
  fieldVariables,
  variables,
  fields,
}) => `
  query ${queryName} ${buildVariables(variables)} {
    ${fieldName} ${buildVariables(fieldVariables)} {
      ${buildSelectionSet(fields)}
    }
  }
`

const buildNodeQueryOnFieldName = ({ fields, fieldName }) =>
  compress(
    buildQuery({
      queryName: `SINGLE_CONTENT_QUERY`,
      variables: `$id: ID!`,
      fieldName,
      fieldVariables: `id: $id`,
      fields: fields,
    })
  )

/**
 * generateNodeQueriesFromIngestibleFields
 *
 * Takes in data from an introspection query and
 * processes it to build GraphQL query strings/info
 *
 * @param {object} introspectionData
 * @returns {Object} GraphQL query info including gql query strings
 */
const generateNodeQueriesFromIngestibleFields = async schema => {
  const {
    fieldBlacklist,
    nodeListFilter,
    typeMap,
    ingestibles: { nodeListRootFields },
  } = schema

  const rootFields = typeMap.get(`RootQuery`).fields

  // @todo This is temporary. We need a list of post types so we
  // can add field arguments just to post type fields so we can
  // get a flat list of posts and pages, instead of having them
  // nested as children
  // for example we need to do posts(where: { parent: null }) { nodes { ... }}
  // https://github.com/wp-graphql/wp-graphql/issues/928
  const {
    data: { postTypes },
  } = await fetchGraphql({ query: availablePostTypesQuery })

  let nodeQueries = {}

  for (const { type, name } of nodeListRootFields) {
    if (fieldBlacklist.includes(name)) {
      continue
    }

    // nested fields
    const fieldFields = typeMap.get(type.name).fields

    // a nested field containing a list of nodes
    const nodesField = fieldFields.find(nodeListFilter)

    // the type of this query
    const nodesType = typeMap.get(nodesField.type.ofType.name)

    const { fields } = nodesType

    const settings = getTypeSettingsByType(nodesType.name)

    if (settings.nodeInterface || settings.exclude) {
      continue
    }

    const singleTypeInfo = rootFields.find(
      field => field.type.name === nodesType.name
    )

    const singleFieldName = singleTypeInfo.name

    const transformedFields = recursivelyTransformFields({ fields })

    const selectionSet = buildSelectionSet(transformedFields)

    const listQueryString = buildNodesQueryOnFieldName({
      fields: transformedFields,
      fieldName: name,
      postTypes,
    })

    const nodeQueryString = buildNodeQueryOnFieldName({
      fields: transformedFields,
      fieldName: singleFieldName,
    })

    // build a query info object containing gql query strings for fetching
    // node lists or single nodes, as well as type info and plugin
    // settings for this type
    nodeQueries[name] = {
      typeInfo: {
        singularName: singleFieldName,
        pluralName: name,
        nodesTypeName: nodesType.name,
      },
      listQueryString,
      nodeQueryString,
      selectionSet,
      settings,
    }
  }

  return nodeQueries
}

module.exports.sourceNodes = async ({
  actions,
  createNodeId,
  createContentDigest,
}) => {
  const { createNode } = actions

  const schema = `
    type Query {
      heroes: [Character]
    }
    
    type Character {
      name: String
    }  
  `

  // { heroes { name } }

  const remoteSchema = await makeRemoteExecutableSchema({
    schema: schema,
  })

  // const {
  //   fieldBlacklist,
  //   nodeListFilter,
  //   typeMap,
  //   // ingestibles: { nodeListRootFields },
  // } = remoteSchema

  console.log(remoteSchema)

  const typeMap = remoteSchema._typeMap

  console.log(typeof typeMap)

  // const {
  //   fieldBlacklist,
  //   nodeListFilter,
  //   typeMap,
  //   ingestibles: { nodeListRootFields },
  // } = schema

  const rootFields = typeMap[`Query`]

  console.log(JSON.stringify(rootFields))

  // let nodeQueries = {}

  for (const { type, name } of rootFields) {
    // if (fieldBlacklist.includes(name)) {
    //   continue
    // }

    // nested fields
    const fieldFields = typeMap.get(type.name).fields

    // a nested field containing a list of nodes
    // const nodesField = fieldFields.find(nodeListFilter)

    // the type of this query
    const nodesType = typeMap.get(nodesField.type.ofType.name)

    const query = buildNodesQueryOnFieldName({ fieldName: name })

    console.log(query)

    // const { fields } = nodesType

    // const settings = getTypeSettingsByType(nodesType.name)

    // if (settings.nodeInterface || settings.exclude) {
    //   continue
    // }

    // const singleTypeInfo = rootFields.find(
    //   field => field.type.name === nodesType.name
    // )

    // const singleFieldName = singleTypeInfo.name

    // const transformedFields = recursivelyTransformFields({ fields })

    // const selectionSet = buildSelectionSet(transformedFields)

    // const listQueryString = buildNodesQueryOnFieldName({
    //   fields: transformedFields,
    //   fieldName: name,
    //   postTypes,
    // })

    // const nodeQueryString = buildNodeQueryOnFieldName({
    //   fields: transformedFields,
    //   fieldName: singleFieldName,
    // })

    // // build a query info object containing gql query strings for fetching
    // // node lists or single nodes, as well as type info and plugin
    // // settings for this type
    // nodeQueries[name] = {
    //   typeInfo: {
    //     singularName: singleFieldName,
    //     pluralName: name,
    //     nodesTypeName: nodesType.name,
    //   },
    //   listQueryString,
    //   nodeQueryString,
    //   selectionSet,
    //   settings,
    // }
  }

  // await generateNodeQueriesFromIngestibleFields(schema)
}
