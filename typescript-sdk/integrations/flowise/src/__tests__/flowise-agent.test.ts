import { FlowiseAgent, FlowiseAgentConfig } from '../flowise-agent';
import { EventType } from '@ag-ui/client';

describe('FlowiseAgent', () => {
  it('should create a FlowiseAgent instance', () => {
    const config: FlowiseAgentConfig = {
      apiUrl: 'http://localhost:3000/api/v1/prediction/{flowId}',
      flowId: 'test-flow-id',
    };

    const agent = new FlowiseAgent(config);
    
    expect(agent).toBeInstanceOf(FlowiseAgent);
    expect(agent).toBeDefined();
  });

  it('should correctly format the API URL', () => {
    const config: FlowiseAgentConfig = {
      apiUrl: 'http://localhost:3000/api/v1/prediction/{flowId}',
      flowId: 'test-flow-id',
    };

    const agent = new FlowiseAgent(config);
    
    // @ts-ignore: accessing private property for testing
    expect(agent.apiUrl).toBe('http://localhost:3000/api/v1/prediction/test-flow-id');
  });

  it('should clone the agent correctly', () => {
    const config: FlowiseAgentConfig = {
      apiUrl: 'http://localhost:3000/api/v1/prediction/{flowId}',
      flowId: 'test-flow-id',
    };

    const agent = new FlowiseAgent(config);
    const clonedAgent = agent.clone();
    
    expect(clonedAgent).toBeInstanceOf(FlowiseAgent);
    expect(clonedAgent).not.toBe(agent);
  });
});