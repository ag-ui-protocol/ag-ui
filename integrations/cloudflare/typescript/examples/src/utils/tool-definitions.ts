/**
 * Centralized tool definitions for Cloudflare agents
 * Ensures consistency across agent implementations
 */


/**
 * Todo Management Tools for Shared State Agent
 * Using explicit tools instead of regex parsing for reliability
 */

export const ADD_TODO_TOOL = {
  name: "add_todo",
  description: "Add a new item to the todo list. Use this when the user asks to add, create, or include a task.",
  parameters: {
    type: "object",
    properties: {
      text: {
        type: "string",
        description: "The todo item text/description",
        minLength: 1,
      },
    },
    required: ["text"],
  },
};

export const REMOVE_TODO_TOOL = {
  name: "remove_todo",
  description: "Remove an item from the todo list. Use this when the user asks to remove, delete, or drop a task.",
  parameters: {
    type: "object",
    properties: {
      text: {
        type: "string",
        description: "The text of the todo item to remove (partial match supported)",
      },
    },
    required: ["text"],
  },
};

export const TOGGLE_TODO_TOOL = {
  name: "toggle_todo",
  description: "Mark a todo item as complete or incomplete. Use this when the user wants to check off or complete a task.",
  parameters: {
    type: "object",
    properties: {
      text: {
        type: "string",
        description: "The text of the todo item to toggle (partial match supported)",
      },
      completed: {
        type: "boolean",
        description: "Whether the item should be marked as completed (true) or incomplete (false)",
      },
    },
    required: ["text", "completed"],
  },
};

export const LIST_TODOS_TOOL = {
  name: "list_todos",
  description: "List all current todo items. Use this when the user asks to see, show, or list their tasks.",
  parameters: {
    type: "object",
    properties: {
      filter: {
        type: "string",
        description: "Optional filter: 'completed', 'incomplete', or 'all' (default)",
        enum: ["completed", "incomplete", "all"],
      },
    },
  },
};

export const CLEAR_TODOS_TOOL = {
  name: "clear_todos",
  description: "Clear all completed todos or all todos. Use this when the user wants to clean up their list.",
  parameters: {
    type: "object",
    properties: {
      clearAll: {
        type: "boolean",
        description: "If true, clear all todos. If false, clear only completed todos.",
        default: false,
      },
    },
  },
};

export const TODO_MANAGEMENT_TOOLS = [
  ADD_TODO_TOOL,
  REMOVE_TODO_TOOL,
  TOGGLE_TODO_TOOL,
  LIST_TODOS_TOOL,
  CLEAR_TODOS_TOOL,
];

/**
 * Haiku generation tool for frontend rendering
 * Used by: tool_based_generative_ui
 */
export const GENERATE_HAIKU_TOOL = {
  name: "generate_haiku",
  description:
    "Generate a traditional Japanese haiku with English translations, including a themed image and background gradient.",
  parameters: {
    type: "object",
    properties: {
      japanese: {
        type: "array",
        description: "Three lines of a 5-7-5 haiku in Japanese.",
        items: { type: "string" },
        minItems: 3,
        maxItems: 3,
      },
      english: {
        type: "array",
        description: "Three lines translating the haiku to English.",
        items: { type: "string" },
        minItems: 3,
        maxItems: 3,
      },
      image_name: {
        type: "string",
        description: "Image filename for the haiku background (e.g., 'cherry-blossoms.jpg')",
      },
      gradient: {
        type: "string",
        description: "CSS gradient string for styling (e.g., 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)')",
      },
    },
    required: ["japanese", "english", "image_name", "gradient"],
  },
};

/**
 * Task steps generation tool for human-in-the-loop approval
 * Used by: human_in_the_loop
 */
export const GENERATE_TASK_STEPS_TOOL = {
  name: "generate_task_steps",
  description: "Present task steps to the user for review and approval before execution.",
  parameters: {
    type: "object",
    properties: {
      steps: {
        type: "array",
        description: "List of task steps for user to review",
        items: {
          type: "object",
          properties: {
            description: {
              type: "string",
              description: "Clear description of the task step"
            },
            enabled: {
              type: "boolean",
              description: "Whether this step is enabled by default"
            }
          },
          required: ["description", "enabled"]
        },
        minItems: 1
      },
      title: {
        type: "string",
        description: "Title for the task plan"
      }
    },
    required: ["steps"]
  },
};

/**
 * Weather display tool for backend-rendered UI
 * Used by: backend_tool_rendering
 */
export const SHOW_WEATHER_TOOL = {
  name: "show_weather",
  description: "Display weather information in a rich UI card with temperature, conditions, and forecast.",
  parameters: {
    type: "object",
    properties: {
      location: {
        type: "string",
        description: "City name or location"
      },
      temperature: {
        type: "number",
        description: "Temperature in Celsius"
      },
      condition: {
        type: "string",
        description: "Weather condition (sunny, cloudy, rainy, etc.)",
        enum: ["sunny", "cloudy", "rainy", "snowy", "windy", "foggy"]
      },
      humidity: {
        type: "number",
        description: "Humidity percentage (0-100)",
        minimum: 0,
        maximum: 100
      },
      windSpeed: {
        type: "number",
        description: "Wind speed in km/h"
      }
    },
    required: ["location", "temperature", "condition"]
  },
};

/**
 * Stock price display tool for backend-rendered UI
 * Used by: backend_tool_rendering
 */
export const SHOW_STOCK_TOOL = {
  name: "show_stock",
  description: "Display stock prices with charts and market data in a rich UI component.",
  parameters: {
    type: "object",
    properties: {
      symbol: {
        type: "string",
        description: "Stock ticker symbol (e.g., AAPL, GOOGL)"
      },
      price: {
        type: "number",
        description: "Current stock price"
      },
      change: {
        type: "number",
        description: "Price change amount"
      },
      changePercent: {
        type: "number",
        description: "Price change percentage"
      },
      volume: {
        type: "number",
        description: "Trading volume"
      },
      marketCap: {
        type: "string",
        description: "Market capitalization (e.g., '2.5T', '100B')"
      }
    },
    required: ["symbol", "price", "change", "changePercent"]
  },
};

/**
 * Calendar event display tool for backend-rendered UI
 * Used by: backend_tool_rendering
 */
export const SHOW_CALENDAR_TOOL = {
  name: "show_calendar",
  description: "Display calendar events in a rich UI timeline component.",
  parameters: {
    type: "object",
    properties: {
      events: {
        type: "array",
        description: "List of calendar events",
        items: {
          type: "object",
          properties: {
            title: { type: "string" },
            start: { type: "string", description: "ISO 8601 datetime" },
            end: { type: "string", description: "ISO 8601 datetime" },
            location: { type: "string" },
            description: { type: "string" }
          },
          required: ["title", "start"]
        }
      },
      viewMode: {
        type: "string",
        description: "Calendar view mode",
        enum: ["day", "week", "month"],
        default: "week"
      }
    },
    required: ["events"]
  },
};

/**
 * Helper to ensure a specific tool is included in the tools array
 */
export function ensureTool(tools: any[] | undefined, toolToAdd: any): any[] {
  const normalized = Array.isArray(tools) ? [...tools] : [];

  const hasTool = normalized.some((tool) => {
    if (!tool) return false;
    if (tool.name === toolToAdd.name) return true;
    return tool.function?.name === toolToAdd.name;
  });

  if (!hasTool) {
    normalized.push(toolToAdd);
  }

  return normalized;
}

/**
 * Helper to ensure multiple tools are included
 */
export function ensureTools(tools: any[] | undefined, toolsToAdd: any[]): any[] {
  let result = tools || [];
  for (const tool of toolsToAdd) {
    result = ensureTool(result, tool);
  }
  return result;
}
