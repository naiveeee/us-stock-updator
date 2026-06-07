export default defineEventHandler((event) => {
  setResponseHeaders(event, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  })
  if (getMethod(event) === 'OPTIONS') {
    event.node.res.statusCode = 204
    event.node.res.end()
  }
})
