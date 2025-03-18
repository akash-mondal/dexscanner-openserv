import 'dotenv/config';

import { getTools, type ToolBase } from '@goat-sdk/core';
import { dexscreener } from '@goat-sdk/plugin-dexscreener'; // Import Dexscreener plugin
import { Agent, type Capability } from '@openserv-labs/sdk';
import { z } from 'zod';
import { createWalletClient, http } from 'viem'; // Import viem functions
import { mainnet } from 'viem/chains';
import { viem } from '@goat-sdk/wallet-viem';
// Import OpenAI (needed for intercepting the request)
import OpenAI from 'openai';

if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is not set');
}

if (!process.env.OPENSERV_API_KEY) {
    throw new Error('OPENSERV_API_KEY is not set');
}

if (!process.env.RPC_PROVIDER_URL) {
  throw new Error('RPC_PROVIDER_URL is not set');
}

const systemPrompt = `
You are a helpful AI assistant that retrieves cryptocurrency pair information from DexScreener.

You have the following capabilities:

*   **dexscreener_search_pairs:** Search for pairs matching a query (e.g., "SOL/USDC").
*   **dexscreener_get_pairs_by_chain_and_pair_id:** Get pair information by chain and pair ID.
*   **dexscreener_get_token_pairs_by_token_address:**  Get pairs associated with the given token address.

**Instructions:**

1.  **Understand the User's Request:** Determine what the user is asking for (searching for pairs, getting a specific pair, etc.).
2.  **Use the Correct Tool:** Select the appropriate tool based on the user's request.
3.  **Provide Concise Information:** Present the relevant information from DexScreener in a clear and user-friendly format. Do not add extra commentary unless specifically requested.

**Example Interactions:**

User: "Find pairs for SOL/USDC"
You: (Use "dexscreener_search_pairs" with query: "SOL/USDC")

User: "Get pair info for chain 'solana' and pair ID 'xyz'"
You: (Use "dexscreener_get_pairs_by_chain_and_pair_id" with chainId: "solana", pairId: "xyz")

User: "Find pairs for token address '0x...'"
You: (Use "dexscreener_get_token_pairs_by_token_address" with tokenAddresses: ["0x..."])
`;

// Map to store original tool names
const toolNameMap = new Map();

const dexAgent = new Agent({
    systemPrompt,
    apiKey: process.env.OPENSERV_API_KEY,
});

const formatToolName = (name) => {
    // Replace dots with underscores to match the required pattern
    return name.replace(/\./g, '_');
};

async function main() {
    const dummyWalletClient = createWalletClient({
        chain: mainnet, // Use mainnet chain definition.
        transport: http(process.env.RPC_PROVIDER_URL), // Use a basic HTTP transport
    }) as any;

    const wallet = viem(dummyWalletClient);

    const allTools = await getTools({
        wallet, // Keep the wallet setup
        plugins: [dexscreener()], // Use the dexscreener plugin
    });

    // Filter *before* mapping to capabilities
    const tools = allTools.filter(tool => tool.name.startsWith('dexscreener'));

    // Store original tools by their formatted names for lookup during execution
    tools.forEach(tool => {
        const formattedName = formatToolName(tool.name);
        toolNameMap.set(formattedName, tool);
    });

    const toCapability = (tool: ToolBase) => {
        // Create a formatted name that follows OpenAI's allowed pattern
        const formattedName = formatToolName(tool.name);
        
        return {
            name: formattedName, // Use formatted name for OpenAI
            description: tool.description,
            schema: tool.parameters,
            async run({ args }) {
                try {
                    // Use the original tool for execution
                    const originalTool = toolNameMap.get(formattedName);
                    if (!originalTool) {
                        throw new Error(`Original tool not found for ${formattedName}`);
                    }
                    
                    const response = await originalTool.execute(args);
                    if (typeof response === 'object') {
                        return JSON.stringify(response, null, 2);
                    }
                    return response.toString();
                } catch (error) {
                    console.error(`Error in capability ${formattedName}:`, error);
                    return `An error occurred while running ${formattedName}: ${error instanceof Error ? error.message : 'Unknown error'}`;
                }
            },
        } as Capability<typeof tool.parameters>;
    };

    const capabilities = tools.map(toCapability);

    try {
        await dexAgent.addCapabilities(capabilities as [
            Capability<z.ZodTypeAny>,
            ...Capability<z.ZodTypeAny>[]
        ]);

        // --- INTERCEPTING AND LOGGING THE OPENAI REQUEST ---
        const originalCreateChatCompletion = dexAgent.openai.chat.completions.create.bind(dexAgent.openai.chat.completions);

        dexAgent.openai.chat.completions.create = async function (
            ...args: Parameters<typeof originalCreateChatCompletion>
        ): ReturnType<typeof originalCreateChatCompletion> {
            const [body, ...rest] = args; // Extract the body (first argument)
            if (body && 'tools' in body) {
                console.log("--- OpenAI Request (Tools): ---");
                console.log(JSON.stringify(body.tools, null, 2)); // Pretty-print the tools
            }
            // Call the original function with all arguments
            return originalCreateChatCompletion(...args);
        } as typeof originalCreateChatCompletion;
            // --- TESTING CODE ---
        const response = await dexAgent.process({
            messages: [
                {
                    role: 'user',
                    content: "What's the current price of CZR/SOL ",
                },
            ],
        });
        console.log("Agent Response:", response.choices[0].message.content);

    } catch (error) {
        console.error(error);
    }
}
dexAgent.start()
main();
