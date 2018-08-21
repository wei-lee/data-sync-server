const _ = require('lodash')
const http = require('http')
const express = require('express')
const { ApolloServer } = require('apollo-server-express')
const cors = require('cors')
const {log} = require('./lib/util/logger')
const expressPino = require('express-pino-logger')({logger: log})
const {runHealthChecks} = require('./health')
const {getMetrics, responseLoggingMetric} = require('./metrics')
const {applyAuthMiddleware} = require('./security')
const schemaParser = require('./lib/schemaParser')
const schemaListenerCreator = require('./lib/schemaListeners/schemaListenerCreator')

function newExpressApp (keycloakConfig, graphqlEndpoint) {
  let app = express()

  app.use(responseLoggingMetric)

  app.use('*', cors())
  app.use(expressPino)
  applyAuthMiddleware(keycloakConfig, app, graphqlEndpoint)
  return app
}

function newApolloServer (app, schema, httpServer, tracing, playgroundConfig, graphqlEndpoint) {
  let apolloServer = new ApolloServer({

    schema,
    context: async ({ req }) => {
      return {
        request: req
      }
    },
    tracing,
    playground: {
      tabs: [
        {
          endpoint: playgroundConfig.endpoint,
          query: playgroundConfig.query,
          variables: JSON.stringify(playgroundConfig.variables)
        }
      ]
    }
  })
  apolloServer.applyMiddleware({ app, disableHealthCheck: true, path: graphqlEndpoint })
  apolloServer.installSubscriptionHandlers(httpServer)

  return apolloServer
}

module.exports = async ({graphQLConfig,
  playgroundConfig,
  schemaListenerConfig,
  keycloakConfig}, models, pubsub) => {
  const { tracing } = graphQLConfig
  let { schema, dataSources } = await buildSchema(models, pubsub)
  await connectDataSources(dataSources)

  let server = http.createServer()

  let graphqlEndpoint = graphQLConfig.graphqlEndpoint
  let app = newExpressApp(keycloakConfig, graphqlEndpoint)
  let apolloServer = newApolloServer(app, schema, server, tracing, playgroundConfig, graphqlEndpoint)
  server.on('request', app)

  app.get('/healthz', async (req, res) => {
    const result = await runHealthChecks(models)
    if (!result.ok) {
      res.status(503)
    }
    res.json(result)
  })

  app.get('/metrics', getMetrics)

  const schemaListener = schemaListenerCreator(schemaListenerConfig)
  if (schemaListener) {
    // "onReceive" will cause the server to reload the configuration which could be costly.
    // don't allow doing it too often!
    // we debounce the "onReceive" callback here to make sure it is debounced
    // for all listener implementations.
    // that means, the callback will be executed after the system waits until there
    // is no request to call it for N milliseconds.
    // like, when there's an evil client that notifies the listener every 100 ms,
    // we still wait for N ms after the notifications are over
    const onReceive = async () => {
      log.info('Received schema change notification. Rebuilding it')
      let newSchema
      try {
        newSchema = await buildSchema(models, pubsub)
      } catch (ex) {
        log.error('Error while reloading config')
        log.error(ex)
        log.error('Will continue using the old config')
      }

      if (newSchema) {
        // first do some cleaning up
        apolloServer.subscriptionServer.close()
        server.removeListener('request', app)
        // reinitialize the server objects
        schema = newSchema.schema
        app = newExpressApp(keycloakConfig, graphqlEndpoint)
        apolloServer = newApolloServer(app, schema, server, tracing, playgroundConfig)
        server.on('request', app)

        try {
          await disconnectDataSources(dataSources) // disconnect existing ones first
        } catch (ex) {
          log.error('Error while disconnecting previous data sources')
          log.error(ex)
          log.error('Will continue connecting to new ones')
        }

        try {
          await connectDataSources(newSchema.dataSources)
          dataSources = newSchema.dataSources
        } catch (ex) {
          log.error('Error while connecting to new data sources')
          log.error(ex)
          log.error('Will use the old schema and the data sources')
          try {
            await connectDataSources(dataSources)
          } catch (ex) {
            log.error('Error while connecting to previous data sources')
            log.error(ex)
          }
        }
      }
    }
    const debouncedOnReceive = _.debounce(onReceive, 500)
    schemaListener.start(debouncedOnReceive)
  }

  const cleanup = async () => {
    await models.sequelize.close()
    if (schemaListener) await schemaListener.stop()
    await disconnectDataSources(dataSources)
    await server.close()
  }

  function startListening (port) {
    var server = this
    return new Promise((resolve) => {
      server.listen(port, resolve)
    })
  }

  server.startListening = startListening.bind(server)

  return {
    server,
    cleanup
  }
}

async function buildSchema (models, pubsub) {
  const graphQLSchemas = await models.GraphQLSchema.findAll()
  let graphQLSchemaString = null

  if (!_.isEmpty(graphQLSchemas)) {
    for (let graphQLSchema of graphQLSchemas) {
      if (graphQLSchema.name === 'default') {
        graphQLSchemaString = graphQLSchema.schema
        break
      }
    }
    if (!graphQLSchemaString) {
      // only fail when there are schemas defined but there's none with the name 'default'
      // things should work fine when there's no schema at all
      throw new Error('No schema with name "default" found.')
    }
  }

  let dataSourcesJson = await models.DataSource.findAll({raw: true})
  const subscriptionsJson = await models.Subscription.findAll({raw: true})

  const resolvers = await models.Resolver.findAll({
    include: [models.DataSource]
  })
  let resolversJson = resolvers.map((resolver) => {
    return resolver.toJSON()
  })

  if (_.isEmpty(graphQLSchemaString) || _.isEmpty(dataSourcesJson) || _.isEmpty(resolversJson)) {
    log.warn('At least one of schema, dataSources or resolvers is missing. Using noop defaults')
    // according to http://facebook.github.io/graphql/June2018/#sec-Root-Operation-Types,
    // a schema has to have 'query' field defined and it must be of object type!
    // let's add 'mutation' and 'subscription' as well, as they're generated by default using resolverMapper
    // and, an object must have a field: http://facebook.github.io/graphql/June2018/#sec-Objects
    graphQLSchemaString = `
      schema {
        query: Query
        mutation: Mutation
        subscription: Subscription
      }
      type Query {
        _: Boolean
      }
      type Mutation {
        _: Boolean
      }
      type Subscription {
        _: Boolean
      }
    `

    dataSourcesJson = {}
    resolversJson = {}
  }

  try {
    return schemaParser(graphQLSchemaString, dataSourcesJson, resolversJson, subscriptionsJson, pubsub)
  } catch (error) {
    log.error('Error while building schema.')
    log.error(error)
    throw (error)
  }
}

async function connectDataSources (dataSources) {
  log.info('Connecting data sources')
  for (let key of Object.keys(dataSources)) {
    const dataSource = dataSources[key]
    try {
      await dataSource.connect()
    } catch (error) {
      log.error(`Error while connecting datasource with key ${key}`)
      log.error(error)
      throw (error)
    }
  }
}

async function disconnectDataSources (dataSources) {
  log.info('Disconnecting data sources')
  for (let key of Object.keys(dataSources)) {
    const dataSource = dataSources[key]
    try {
      await dataSource.disconnect()
    } catch (error) {
      log.error(`Error while disconnecting datasource with key ${key}`)
      log.error(error)
      // swallow
    }
  }
}
