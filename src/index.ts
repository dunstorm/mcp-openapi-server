#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { OpenAPIV3 } from "openapi-types";
import axios from "axios";
import { readFile } from "fs/promises";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema, // Changed from ExecuteToolRequestSchema
  Tool,
} from "@modelcontextprotocol/sdk/types.js";

interface ArgsType {
  "api-base-url"?: string;
  "openapi-spec"?: string;
  headers?: string;
  name?: string;
  version?: string;
  [key: string]: unknown;
}

// Define the Tool schema interface
interface ToolSchema {
  type: "object";
  properties: Record<string, any>;
  required?: string[];
  [k: string]: unknown;
}

// Define an interface for Swagger 2.0 Parameter Object
interface SwaggerParameterObject {
  name: string;
  in: "query" | "header" | "path" | "formData" | "body";
  description?: string;
  required?: boolean;
  type?: string; // 'string', 'number', 'integer', 'boolean', 'array', 'file'
  items?: { type?: string; format?: string; [key: string]: any }; // For array type
  schema?: OpenAPIV3.SchemaObject; // For 'body' parameter
  [key: string]: any; // Allow other properties
}

interface ToolDetails {
  toolDef: Tool;
  apiPath: string; // Original path template, e.g., /users/{id}
  apiMethod: string;
  parametersSpec: SwaggerParameterObject[];
}

interface OpenAPIMCPServerConfig {
  name: string;
  version: string;
  apiBaseUrl: string;
  openApiSpec: OpenAPIV3.Document | string;
  headers?: Record<string, string>;
}

function parseHeaders(headerStr?: string): Record<string, string> {
  const headers: Record<string, string> = {};
  if (headerStr) {
    headerStr.split(",").forEach((header) => {
      const [key, value] = header.split(":");
      if (key && value) headers[key.trim()] = value.trim();
    });
  }
  return headers;
}

function loadConfig(): OpenAPIMCPServerConfig {
  const argv = yargs(hideBin(process.argv))
    .option("api-base-url", {
      alias: "u",
      type: "string",
      description: "Base URL for the API",
    })
    .option("openapi-spec", {
      alias: "s",
      type: "string",
      description: "Path or URL to OpenAPI specification",
    })
    .option("headers", {
      alias: "H",
      type: "string",
      description: "API headers in format 'key1:value1,key2:value2'",
    })
    .option("name", {
      alias: "n",
      type: "string",
      description: "Server name",
    })
    .option("version", {
      alias: "v",
      type: "string",
      description: "Server version",
    })
    .help()
    .parseSync() as ArgsType;

  // Combine CLI args and env vars, with CLI taking precedence
  const apiBaseUrl = argv["api-base-url"] || process.env.API_BASE_URL;
  const openApiSpec = argv["openapi-spec"] || process.env.OPENAPI_SPEC_PATH;

  if (!apiBaseUrl) {
    throw new Error(
      "API base URL is required (--api-base-url or API_BASE_URL)",
    );
  }
  if (!openApiSpec) {
    throw new Error(
      "OpenAPI spec is required (--openapi-spec or OPENAPI_SPEC_PATH)",
    );
  }

  const headers = parseHeaders(argv.headers || process.env.API_HEADERS);

  return {
    name: argv.name || process.env.SERVER_NAME || "mcp-openapi-server",
    version: argv.version || process.env.SERVER_VERSION || "1.0.0",
    apiBaseUrl,
    openApiSpec,
    headers,
  };
}

class OpenAPIMCPServer {
  private server: Server;
  private config: OpenAPIMCPServerConfig;

  private toolExecutionDetails: Map<string, ToolDetails> = new Map();

  constructor(config: OpenAPIMCPServerConfig) {
    this.config = config;
    this.server = new Server({
      name: config.name,
      version: config.version,
    });

    this.initializeHandlers();
  }

  private async loadOpenAPISpec(): Promise<OpenAPIV3.Document> {
    if (typeof this.config.openApiSpec === "string") {
      if (this.config.openApiSpec.startsWith("http")) {
        // Load from URL
        const response = await axios.get(this.config.openApiSpec);
        return response.data as OpenAPIV3.Document;
      } else {
        // Load from local file
        const content = await readFile(this.config.openApiSpec, "utf-8");
        return JSON.parse(content) as OpenAPIV3.Document;
      }
    }
    return this.config.openApiSpec as OpenAPIV3.Document;
  }

  private async parseOpenAPISpec(): Promise<void> {
    const spec = await this.loadOpenAPISpec();

    // Convert each OpenAPI path to an MCP tool
    for (const [path, pathItem] of Object.entries(spec.paths)) {
      if (!pathItem) continue;

      for (const [method, operation] of Object.entries(pathItem)) {
        if (method === "parameters" || !operation) continue;

        const op = operation as any; // Using any since we're handling Swagger 2.0
        // Create a clean tool ID by removing the leading slash and replacing special chars
        const cleanPathIdPart = path.replace(/^\//, "").replace(/[{}]/g, ""); // Remove braces for ID - simplified regex
        const toolId = `${method.toUpperCase()}-${cleanPathIdPart}`.replace(
          /[^a-zA-Z0-9-]/g,
          "-",
        );
        
        const toolSchema: ToolSchema = {
          type: "object",
          properties: {},
        };
        
        const mcpTool: Tool = {
          name: sanitizeToolName(op.summary || `${method.toUpperCase()} ${path}`),
          description: op.description || `Make a ${method.toUpperCase()} request to ${path}`,
          inputSchema: toolSchema,
        };

        console.error(`Registering tool: ${toolId} (${mcpTool.name})`);

        const parametersSpec: SwaggerParameterObject[] = [];

        if (op.parameters) {
          // console.error(`Parameters: ${JSON.stringify(op.parameters)}`);
          for (const param of op.parameters as SwaggerParameterObject[]) {
            if (param.name && param.in) {
              parametersSpec.push(param); // Store the full parameter spec

              toolSchema.properties[param.name] = {
                type: param.type || "string", // Fallback to string if type is missing
                description: param.description || `${param.name} parameter`,
              };
              if (param.type === "array" && param.items) {
                toolSchema.properties[param.name].items = {
                  type: param.items.type || "string",
                };
              } else if (param.in === "body" && param.schema) {
                // For body parameters, try to represent the schema
                // This is a simplified representation; full JSON schema conversion can be complex
                toolSchema.properties[param.name].type = "object"; // Body params are often objects
                // Optionally, you could try to convert param.schema to a more detailed MCP schema
              }


              if (param.required) {
                if (!toolSchema.required) {
                  toolSchema.required = [];
                }
                toolSchema.required.push(param.name);
              }
            }
          }
        }
        this.toolExecutionDetails.set(toolId, {
          toolDef: mcpTool,
          apiPath: path, // Store original path template
          apiMethod: method.toUpperCase(),
          parametersSpec,
        });
      }
    }
  }

  private initializeHandlers(): void {
    // Handle tool listing
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: Array.from(this.toolExecutionDetails.values()).map(
          (details) => details.toolDef,
        ),
      };
    });

    // Handle tool execution
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { id, name, arguments: params } = request.params;

      console.error("Received request:", request.params);
      console.error("Using parameters from arguments:", params);

      // Find tool by ID or name
      let toolDetails: ToolDetails | undefined;
      let toolId: string | undefined;

      if (id && typeof id === 'string') {
        toolId = id.trim();
        toolDetails = this.toolExecutionDetails.get(toolId);
      } else if (name) {
        // Search for tool by name
        for (const [tid, details] of this.toolExecutionDetails.entries()) {
          if (details.toolDef.name === name) {
            toolDetails = details;
            toolId = tid;
            break;
          }
        }
      }

      if (!toolDetails || !toolId) {
        console.error(
          `Available tools: ${Array.from(this.toolExecutionDetails.entries())
            .map(([id, details]) => `${id} (${details.toolDef.name})`)
            .join(", ")}`,
        );
        throw new Error(`Tool not found: ${id || name}`);
      }
      
      const { toolDef, apiPath: originalPath, apiMethod, parametersSpec } = toolDetails;

      console.error(`Executing tool: ${toolId} (${toolDef.name})`);
      console.error(`Original API path template: ${originalPath}`);
      console.error(`API method: ${apiMethod}`);
      console.error(`Parameter specs: ${JSON.stringify(parametersSpec)}`);
      console.error(`Provided arguments: ${JSON.stringify(params)}`);


      try {
        let processedPath = originalPath;
        const queryParams: Record<string, string | string[]> = {};
        let requestBody: any = undefined;
        const requestHeaders = { ...this.config.headers }; // Start with base headers

        if (params && typeof params === "object") {
          for (const spec of parametersSpec) {
            const value = (params as Record<string, any>)[spec.name];
            if (value === undefined && spec.required) {
              throw new Error(`Missing required parameter: ${spec.name}`);
            }
            if (value === undefined) continue;

            switch (spec.in) {
              case "path":
                processedPath = processedPath.replace(`{${spec.name}}`, String(value));
                break;
              case "query":
                if (Array.isArray(value)) {
                  queryParams[spec.name] = value.map(String);
                } else {
                  queryParams[spec.name] = String(value);
                }
                break;
              case "header":
                requestHeaders[spec.name] = String(value);
                break;
              case "body":
                requestBody = value; // Assumes 'value' is the entire body object
                break;
              case "formData":
                // FormData handling can be complex, often requires specific content types
                // For simplicity, if it's an object, pass it as body.
                // For more complex scenarios, libraries like 'form-data' might be needed.
                if (typeof value === "object" && !requestBody) {
                  requestBody = value; // Or convert to FormData
                  // Ensure Content-Type is set appropriately, e.g., application/x-www-form-urlencoded or multipart/form-data
                } else {
                  console.warn(`FormData parameter '${spec.name}' might not be handled correctly as simple value.`);
                  // Fallback or specific handling might be needed here
                  if (!requestBody) requestBody = {};
                  (requestBody as Record<string, any>)[spec.name] = value;
                }
                break;
            }
          }
        }
        
        console.error(`Processed path: ${processedPath}`);
        console.error(`Query params: ${JSON.stringify(queryParams)}`);
        if (requestBody) console.error(`Request body: ${JSON.stringify(requestBody)}`);
        console.error(`Request headers: ${JSON.stringify(requestHeaders)}`);


        // Ensure base URL ends with slash for proper joining
        const baseUrl = this.config.apiBaseUrl.endsWith("/")
          ? this.config.apiBaseUrl
          : `${this.config.apiBaseUrl}/`;

        // Remove leading slash from path to avoid double slashes if present
        const cleanPath = processedPath.startsWith("/") ? processedPath.slice(1) : processedPath;
        const fullUrl = new URL(cleanPath, baseUrl).toString();

        const axiosConfig: any = {
          method: apiMethod.toLowerCase(),
          url: fullUrl,
          headers: requestHeaders,
        };

        if (Object.keys(queryParams).length > 0) {
          // For GET requests, ensure parameters are properly structured
          if (apiMethod.toLowerCase() === "get" || apiMethod.toLowerCase() === "delete") { // Also for DELETE often
             // Handle array parameters properly for query
            const finalQueryParams: Record<string, string> = {};
            for (const [key, val] of Object.entries(queryParams)) {
              if (Array.isArray(val)) {
                finalQueryParams[key] = val.join(","); // Default CSV, adjust if API needs other format
              } else {
                finalQueryParams[key] = String(val);
              }
            }
            axiosConfig.params = finalQueryParams;
          } else if (requestBody === undefined) {
            // If not GET/DELETE and no body yet, form data might go here (e.g. x-www-form-urlencoded)
            // This depends on the Content-Type; for now, assume JSON if body is set later
            // If Content-Type is x-www-form-urlencoded, queryParams might need to be stringified
             console.warn("Query parameters for non-GET/DELETE request without explicit body. Review API spec.");
             axiosConfig.data = queryParams; // Or URLSearchParams(queryParams).toString() if content-type is form-urlencoded

          }
        }
        
        if (requestBody !== undefined) {
          axiosConfig.data = requestBody;
        }


        console.error("Final request config:", JSON.stringify(axiosConfig, null, 2));

        try {
          const response = await axios(axiosConfig);
          console.error("Response status:", response.status);
          console.error("Response headers:", response.headers);
          console.error("Response data:", response.data);
          return {
            content: [{
              type: "text",
              text: JSON.stringify(response.data, null, 2)
            }]
          };
        } catch (error) {
          if (axios.isAxiosError(error)) {
            console.error("Request failed:", {
              status: error.response?.status,
              statusText: error.response?.statusText,
              data: error.response?.data,
              headers: error.response?.headers,
            });
            throw new Error(
              `API request failed: ${error.message} - ${JSON.stringify(error.response?.data)}`,
            );
          }
          throw error;
        }

      } catch (error) {
        if (axios.isAxiosError(error)) {
          throw new Error(`API request failed: ${error.message}`);
        }
        throw error;
      }
    });
  }

  async start(): Promise<void> {
    await this.parseOpenAPISpec();
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error("OpenAPI MCP Server running on stdio");
  }
}

async function main(): Promise<void> {
  try {
    const config = loadConfig();
    const server = new OpenAPIMCPServer(config);
    await server.start();
  } catch (error) {
    console.error("Failed to start server:", error);
    process.exit(1);
  }
}

function sanitizeToolName(name: string): string {
  // Replace any non-alphanumeric characters with underscores
  let sanitized = name.replace(/[^a-zA-Z0-9_]/g, '_');
  
  // Ensure it's not longer than 64 characters
  sanitized = sanitized.substring(0, 64);
  
  // Ensure it's not empty
  if (sanitized.length === 0) {
    sanitized = 'tool';
  }
  
  return sanitized;
}

main();

export { OpenAPIMCPServer, loadConfig };
