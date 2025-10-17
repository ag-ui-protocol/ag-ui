/**
 * Tool-Based Generative UI Agent (Agents SDK)
 * Generates haikus with custom UI rendering parameters
 */

export class ToolBasedGenerativeUiAgent {
  id = "tool-based-generative-ui-agent";
  private state: Record<string, any> = {};

  async setState(state: Record<string, any>): Promise<void> {
    this.state = { ...this.state, ...state };
  }

  getState(): Record<string, any> {
    return this.state;
  }

  async sql<T = any>(query: TemplateStringsArray, ...values: any[]): Promise<T[]> {
    return [];
  }

  async schedule(when: string | Date | number, callback: string, data?: any): Promise<void> {
    // No-op for example
  }

  /**
   * Handles chat messages and generates haikus with UI parameters
   */
  async *onChatMessage(message: string, context: any): AsyncGenerator<any> {
    const lowerMessage = message.toLowerCase();

    // Check if user is asking for a haiku
    if (lowerMessage.includes("haiku")) {
      // Extract topic from message
      const topic = this.extractTopic(message);

      // Generate haiku based on topic
      const haiku = this.generateHaiku(topic);

      // Acknowledge
      yield `I'll create a haiku about ${topic} for you.\n\n`;

      // Start tool call
      yield {
        type: "tool_call",
        toolCall: {
          id: "haiku-tc-1",
          name: "generate_haiku",
        }
      };

      // Stream the tool arguments
      const argsJson = JSON.stringify({
        japanese: haiku.japanese,
        english: haiku.english,
        image_name: haiku.image,
        gradient: haiku.gradient
      });

      for (let i = 0; i < argsJson.length; i += 25) {
        const chunk = argsJson.substring(i, i + 25);
        yield {
          type: "tool_call_delta",
          toolCall: {
            id: "haiku-tc-1",
            argsChunk: chunk,
          }
        };
      }

      // Complete tool call with full args
      yield {
        type: "tool_call",
        toolCall: {
          id: "haiku-tc-1",
          name: "generate_haiku",
          done: true,
          args: {
            japanese: haiku.japanese,
            english: haiku.english,
            image_name: haiku.image,
            gradient: haiku.gradient
          }
        }
      };

      yield "\n\nEnjoy your haiku! 🌸";
    } else {
      // Not a haiku request
      yield "I'm a haiku generator! Ask me to create a haiku about any topic. For example: 'Generate a haiku about coding' or 'Write me a haiku about spring'.";
    }
  }

  /**
   * Extract topic from user message
   */
  private extractTopic(message: string): string {
    const lowerMessage = message.toLowerCase();

    // Common patterns
    if (lowerMessage.includes("about ")) {
      const match = message.match(/about ([a-zA-Z\s]+)/i);
      if (match) return match[1].trim();
    }

    // Default topics based on keywords
    if (lowerMessage.includes("spring")) return "spring";
    if (lowerMessage.includes("code") || lowerMessage.includes("typescript") || lowerMessage.includes("programming")) return "coding";
    if (lowerMessage.includes("summer")) return "summer";
    if (lowerMessage.includes("winter")) return "winter";
    if (lowerMessage.includes("fall") || lowerMessage.includes("autumn")) return "autumn";

    return "nature";
  }

  /**
   * Generate haiku with UI parameters
   */
  private generateHaiku(topic: string): {
    japanese: string[];
    english: string[];
    image: string;
    gradient: string;
  } {
    const haikus: Record<string, any> = {
      spring: {
        japanese: ["", "", ""],
        english: [
          "Cherry blossoms fall",
          "Soft petals dance on the breeze",
          "Spring awakens now"
        ],
        image: "Mount_Fuji_Lake_Reflection_Cherry_Blossoms_Sakura_Spring.jpg",
        gradient: "linear-gradient(90deg, #ff99cc 0%, #ff99cc 35%, #ffffff 100%)"
      },
      coding: {
        japanese: ["", "", ""],
        english: [
          "Functions compile",
          "Logic flows through typed code",
          "Bugs fade into night"
        ],
        image: "code_pattern.jpg",
        gradient: "linear-gradient(135deg, #667eea 0%, #764ba2 100%)"
      },
      summer: {
        japanese: ["", "", ""],
        english: [
          "Warm sun shines above",
          "Ocean waves crash on the shore",
          "Summer joy unfolds"
        ],
        image: "summer_beach.jpg",
        gradient: "linear-gradient(120deg, #f6d365 0%, #fda085 100%)"
      },
      winter: {
        japanese: ["", "", ""],
        english: [
          "Snowflakes gently fall",
          "White blanket covers the earth",
          "Silent peace descends"
        ],
        image: "winter_landscape.jpg",
        gradient: "linear-gradient(135deg, #a8edea 0%, #fed6e3 100%)"
      },
      autumn: {
        japanese: ["", "", ""],
        english: [
          "Leaves turn gold and red",
          "Cool winds whisper through the trees",
          "Autumn's gift appears"
        ],
        image: "autumn_forest.jpg",
        gradient: "linear-gradient(135deg, #f093fb 0%, #f5576c 100%)"
      },
      nature: {
        japanese: ["", "", ""],
        english: [
          "Mountains stand so tall",
          "Rivers flow through ancient stone",
          "Nature's song endures"
        ],
        image: "mountain_landscape.jpg",
        gradient: "linear-gradient(135deg, #13547a 0%, #80d0c7 100%)"
      }
    };

    return haikus[topic] || haikus.nature;
  }

  async onRequest(request: Request): Promise<Response> {
    return new Response("Use AG-UI adapter", { status: 501 });
  }
}

/**
 * Singleton instance
 */
let _agent: ToolBasedGenerativeUiAgent | null = null;

export function getToolBasedGenerativeUiAgent(): ToolBasedGenerativeUiAgent {
  if (!_agent) {
    _agent = new ToolBasedGenerativeUiAgent();
  }
  return _agent;
}
