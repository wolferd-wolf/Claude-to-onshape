import { Hono } from 'hono'

const app = new Hono()

app.get('/', (c) => {
  return c.json({
    name: 'Onshape Claude MCP',
    status: 'online'
  })
})

app.get('/mcp', (c) => {
  return c.json({
    name: 'Onshape Claude MCP',
    status: 'online',
    message: 'MCP endpoint is running'
  })
})

export default app
