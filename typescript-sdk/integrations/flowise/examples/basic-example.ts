import { FlowiseAgent, FlowiseAgentConfig } from '../src';

// Configure the Flowise agent
const config: FlowiseAgentConfig = {
  apiUrl: 'http://localhost:3000/api/v1/prediction/{flowId}',
  flowId: 'your-flow-id',
  apiKey: 'your-api-key', // Optional
};

// Create the agent
const agent = new FlowiseAgent(config);

// Use the agent with AG-UI components
console.log('Flowise agent created successfully!');