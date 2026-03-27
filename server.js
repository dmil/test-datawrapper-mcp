import 'dotenv/config';
import express from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const app = express();
app.use(express.json());
app.use(express.static('public'));

const MCP_URL = process.env.MCP_URL || 'https://datawrapper-mcp.fly.dev/mcp';
const SERVER_OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
const SERVER_DATAWRAPPER_TOKEN = process.env.DATAWRAPPER_TOKEN || '';
const DEFAULT_MODEL = process.env.MODEL || 'anthropic/claude-3-haiku';
const PORT = process.env.PORT || 3000;

const SYSTEM_PROMPT =
  'You are a helpful assistant with access to Datawrapper, a data visualization platform. ' +
  'You can help users create, modify, publish, and manage charts and data visualizations. ' +
  'When a user asks you to create or change a chart, use the available Datawrapper tools to do so and ' +
  'share any chart URLs or embed codes you receive back.';

// ----- MCP helpers --------------------------------------------------------

async function createMCPClient(datawrapperToken) {
  const client = new Client({ name: 'datawrapper-web', version: '1.0.0' });
  const requestInit = datawrapperToken
    ? { headers: { Authorization: `Bearer ${datawrapperToken}` } }
    : {};
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
    requestInit,
  });
  await client.connect(transport);
  return client;
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
  const client = await createMCPClient(datawrapperToken);
  try {
    const tools = await listToolsAsOpenAI(client);
    const conversation = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...messages,
    ];

    const collectedImages = [];
    const toolCallEvents = [];
    const MAX_AGENT_LOOP_ITERATIONS = 15;
    for (let i = 0; i < MAX_AGENT_LOOP_ITERATIONS; i++) {
      const body = {
        model,
        messages: conversation,
      };
      if (tools.length > 0) {
        body.tools = tools;
      }

      const response = await fetch(
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
      );

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`OpenRouter error ${response.status}: ${errText}`);
      }

      const data = await response.json();
      const message = data.choices[0].message;
      conversation.push(message);

      // No tool calls — we have the final answer
      if (!message.tool_calls || message.tool_calls.length === 0) {
        return { reply: message.content, images: collectedImages, conversation, toolCalls: toolCallEvents };
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
          try {
            const toolResult = await client.callTool({
              name: call.function.name,
              arguments: args,
            });
            const { text, images } = extractContent(toolResult.content);
            resultText = text;
            collectedImages.push(...images);
            toolCallEvents.push({ name: call.function.name, args, result: resultText, failed: Boolean(toolResult.isError) });
          } catch (err) {
            resultText = `Tool error: ${err.message}`;
            toolCallEvents.push({ name: call.function.name, args, result: resultText, failed: true });
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
    await client.close();
  }
}

// ----- Routes -------------------------------------------------------------

app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    mcpUrl: MCP_URL,
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
    console.error('Chat error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Datawrapper MCP Web → http://localhost:${PORT}`);
  console.log(`MCP server          → ${MCP_URL}`);
  console.log(`Default model       → ${DEFAULT_MODEL}`);
  if (!SERVER_OPENROUTER_API_KEY) {
    console.log(
      'Note: OPENROUTER_API_KEY not set — users must supply their own key.'
    );
  }
});
