import 'dotenv/config';
import express from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const app = express();
// The browser resends the whole conversation, tool results included, each turn
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));
app.use('/vendor/marked', express.static('node_modules/marked/lib'));
app.use('/vendor/dompurify', express.static('node_modules/dompurify/dist'));

const MCP_URL = process.env.MCP_URL || 'https://datawrapper-mcp.fly.dev/mcp';
// Set SOCRATA_MCP_URL to an empty string to disable the Socrata server.
const SOCRATA_MCP_URL = process.env.SOCRATA_MCP_URL ?? 'https://socrata-mcp.civicaitools.org/mcp';
const SERVER_OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
const SERVER_DATAWRAPPER_TOKEN = process.env.DATAWRAPPER_TOKEN || '';
const DEFAULT_MODEL = process.env.MODEL || 'anthropic/claude-haiku-5.5';
const PORT = process.env.PORT || 3000;

const DATAWRAPPER_PROMPT =
  'You are a helpful assistant with access to Datawrapper, a data visualization platform. ' +
  'You can help users create, modify, publish, and manage charts and data visualizations. ' +
  'When a user asks you to create or change a chart, use the available Datawrapper tools to do so and ' +
  'share any chart URLs or embed codes you receive back.';

const SOCRATA_PROMPT =
  ' You also have access to Socrata open data portals (e.g. data.cityofnewyork.us, data.cityofchicago.org) ' +
  'through the get_data, search and fetch tools. When a user asks about public data, find the relevant ' +
  'dataset, query it with SoQL (aggregate on the portal with select/group/where rather than pulling raw rows), ' +
  'and cite the dataset you used. When they want a chart of that data, pass the query results to Datawrapper.';

// ----- Network helpers ----------------------------------------------------

// Node's fetch reports every network-level failure (DNS, refused, reset, a
// stale keep-alive socket closed by a proxy) as a bare "fetch failed" with the
// real reason in err.cause. Name the service that failed and surface the reason.
async function labelNetworkErrors(service, fn) {
  try {
    return await fn();
  } catch (err) {
    const isNetwork = err.message === 'fetch failed' || err.cause?.code;
    if (!isNetwork) throw err;
    const reason = err.cause?.code || err.cause?.message || err.message;
    throw new Error(`Couldn't reach ${service} (${reason}).`, { cause: err.cause });
  }
}

// ----- MCP helpers --------------------------------------------------------

async function createMCPClient(url, requestInit = {}) {
  const client = new Client({ name: 'datawrapper-web', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit,
  });
  await client.connect(transport);
  return client;
}

// Connects to every configured MCP server. Datawrapper is required; Socrata is
// optional, so if it is down the chat still works with Datawrapper alone.
async function connectServers(datawrapperToken) {
  const datawrapperInit = datawrapperToken
    ? { headers: { Authorization: `Bearer ${datawrapperToken}` } }
    : {};
  const [datawrapper, socrata] = await Promise.allSettled([
    labelNetworkErrors('the Datawrapper MCP server', () => createMCPClient(MCP_URL, datawrapperInit)),
    SOCRATA_MCP_URL
      ? labelNetworkErrors('the Socrata MCP server', () => createMCPClient(SOCRATA_MCP_URL))
      : Promise.resolve(null),
  ]);

  const servers = [];
  if (socrata.status === 'fulfilled' && socrata.value) {
    servers.push({ name: 'socrata', client: socrata.value });
  } else if (socrata.status === 'rejected') {
    console.error('Socrata MCP unavailable:', socrata.reason?.message);
  }
  if (datawrapper.status === 'rejected') {
    await Promise.all(servers.map((s) => s.client.close()));
    throw datawrapper.reason;
  }
  servers.unshift({ name: 'datawrapper', client: datawrapper.value });
  return servers;
}

async function listToolsAsOpenAI(client) {
  const result = await client.listTools();
  return result.tools.map((tool) => {
    // Strip access_token from schema — auth is handled via the Authorization header
    const schema = tool.inputSchema ? { ...tool.inputSchema } : {};
    if (schema.properties) {
      const { access_token, ...rest } = schema.properties;
      schema.properties = rest;
    }
    if (Array.isArray(schema.required)) {
      schema.required = schema.required.filter((k) => k !== 'access_token');
    }
    return {
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: schema,
      },
    };
  });
}

function extractContent(content) {
  const texts = [];
  const images = [];
  if (!content) return { text: '', images };
  if (typeof content === 'string') return { text: content, images };
  if (Array.isArray(content)) {
    for (const c of content) {
      if (typeof c === 'string') {
        texts.push(c);
      } else if (c.type === 'text') {
        texts.push(c.text);
      } else if (c.type === 'image') {
        images.push({ mimeType: c.mimeType, data: c.data });
      } else {
        texts.push(JSON.stringify(c));
      }
    }
    return { text: texts.join('\n'), images };
  }
  return { text: JSON.stringify(content), images };
}

// ----- Agentic loop -------------------------------------------------------

async function runAgentLoop(messages, datawrapperToken, openrouterKey, model) {
  const servers = await connectServers(datawrapperToken);
  try {
    // Merge every server's tools and remember which server owns each one
    const tools = [];
    const toolServer = new Map();
    for (const server of servers) {
      for (const tool of await listToolsAsOpenAI(server.client)) {
        const name = tool.function.name;
        if (toolServer.has(name)) {
          console.error(`Duplicate tool "${name}" from ${server.name}; keeping ${toolServer.get(name).name}'s`);
          continue;
        }
        toolServer.set(name, server);
        tools.push(tool);
      }
    }

    const hasSocrata = servers.some((s) => s.name === 'socrata');
    const conversation = [
      { role: 'system', content: DATAWRAPPER_PROMPT + (hasSocrata ? SOCRATA_PROMPT : '') },
      ...messages,
    ];

    const collectedImages = [];
    const toolCallEvents = [];
    const usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cost: 0 };
    const MAX_AGENT_LOOP_ITERATIONS = 15;
    for (let i = 0; i < MAX_AGENT_LOOP_ITERATIONS; i++) {
      const body = {
        model,
        messages: conversation,
      };
      if (tools.length > 0) {
        body.tools = tools;
      }

      const response = await labelNetworkErrors('OpenRouter', () => fetch(
        'https://openrouter.ai/api/v1/chat/completions',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${openrouterKey}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': 'https://github.com/dmil/test-datawrapper-mcp',
            'X-Title': 'Datawrapper MCP Web',
          },
          body: JSON.stringify(body),
        }
      ));

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`OpenRouter error ${response.status}: ${errText}`);
      }

      const data = await response.json();
      if (data.usage) {
        usage.prompt_tokens += data.usage.prompt_tokens || 0;
        usage.completion_tokens += data.usage.completion_tokens || 0;
        usage.total_tokens += data.usage.total_tokens || 0;
        usage.cost += data.usage.cost || 0;
      }
      const message = data.choices[0].message;
      conversation.push(message);

      // No tool calls — we have the final answer
      if (!message.tool_calls || message.tool_calls.length === 0) {
        return { reply: message.content, images: collectedImages, conversation, toolCalls: toolCallEvents, usage };
      }

      // Execute every tool call and append results
      const toolResults = await Promise.all(
        message.tool_calls.map(async (call) => {
          let resultText;
          const args =
            typeof call.function.arguments === 'string'
              ? JSON.parse(call.function.arguments)
              : call.function.arguments;
          delete args.access_token; // auth is handled via Authorization header
          const server = toolServer.get(call.function.name);
          try {
            if (!server) throw new Error(`Unknown tool "${call.function.name}"`);
            const toolResult = await server.client.callTool({
              name: call.function.name,
              arguments: args,
            });
            const { text, images } = extractContent(toolResult.content);
            resultText = text;
            collectedImages.push(...images);
            toolCallEvents.push({ name: call.function.name, server: server.name, args, result: resultText, failed: Boolean(toolResult.isError) });
          } catch (err) {
            resultText = `Tool error: ${err.message}`;
            toolCallEvents.push({ name: call.function.name, server: server?.name, args, result: resultText, failed: true });
          }
          return {
            role: 'tool',
            tool_call_id: call.id,
            content: resultText,
          };
        })
      );

      conversation.push(...toolResults);
    }

    throw new Error('Agent loop exceeded maximum iterations without a final reply');
  } finally {
    await Promise.all(servers.map((s) => s.client.close()));
  }
}

// ----- Routes -------------------------------------------------------------

app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    mcpUrl: MCP_URL,
    socrataMcpUrl: SOCRATA_MCP_URL || null,
    defaultModel: DEFAULT_MODEL,
    serverKeyConfigured: Boolean(SERVER_OPENROUTER_API_KEY),
  });
});

app.get('/api/config', (_req, res) => {
  res.json({
    hasOpenrouterKey: Boolean(SERVER_OPENROUTER_API_KEY),
    hasDatawrapperToken: Boolean(SERVER_DATAWRAPPER_TOKEN),
    defaultModel: DEFAULT_MODEL,
  });
});

app.post('/api/chat', async (req, res) => {
  try {
    const {
      messages,
      datawrapperToken,
      openrouterKey,
      model = DEFAULT_MODEL,
    } = req.body;

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages array is required' });
    }

    const apiKey = openrouterKey || SERVER_OPENROUTER_API_KEY;
    if (!apiKey) {
      return res
        .status(400)
        .json({
          error:
            'An OpenRouter API key is required. Provide it in the settings panel or ask the server administrator to set OPENROUTER_API_KEY.',
        });
    }

    const result = await runAgentLoop(
      messages,
      datawrapperToken || SERVER_DATAWRAPPER_TOKEN || null,
      apiKey,
      model
    );
    res.json(result);
  } catch (err) {
    console.error('Chat error:', err.message, err.cause ?? '');
    res.status(500).json({ error: err.message });
  }
});

// Return errors (e.g. an oversized or malformed request body) as JSON, not HTML
app.use((err, _req, res, _next) => {
  console.error('Request error:', err.message);
  const error = err.type === 'entity.too.large'
    ? 'This conversation has grown too large to send. Refresh the page to start a new chat.'
    : err.message;
  res.status(err.status || 500).json({ error });
});

app.listen(PORT, () => {
  console.log(`Datawrapper MCP Web → http://localhost:${PORT}`);
  console.log(`MCP server          → ${MCP_URL}`);
  console.log(`Socrata MCP server  → ${SOCRATA_MCP_URL || '(disabled)'}`);
  console.log(`Default model       → ${DEFAULT_MODEL}`);
  if (!SERVER_OPENROUTER_API_KEY) {
    console.log(
      'Note: OPENROUTER_API_KEY not set — users must supply their own key.'
    );
  }
});
