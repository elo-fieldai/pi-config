/**
 * Jira Ticket Extension
 *
 * Adds a create_jira_ticket tool plus /jira-create and /jira-config commands.
 *
 * Required for real issue creation:
 *   JIRA_BASE_URL=https://your-site.atlassian.net
 *   JIRA_PROJECT_KEY=ABC
 *   JIRA_EMAIL=you@example.com
 *   JIRA_API_TOKEN=...
 *
 * Alternative auth:
 *   JIRA_BEARER_TOKEN=...
 *
 * Optional:
 *   JIRA_ISSUE_TYPE=Task
 *   JIRA_API_VERSION=3
 *   JIRA_DRY_RUN=true
 *   JIRA_ALLOW_NON_INTERACTIVE_CREATE=true
 */

import type {
  ExtensionAPI, ExtensionContext} from "@earendil-works/pi-coding-agent";
import {Buffer} from "node:buffer";
import {Type} from "typebox";

const DEFAULT_ISSUE_TYPE = "Task";
const DEFAULT_API_VERSION = "3";
const MAX_ERROR_CHARS = 4_000;

interface CreateJiraTicketParams {
  summary: string;
  description?: string;
  projectKey?: string;
  issueType?: string;
  labels?: string[];
  components?: string[];
  priority?: string;
  assigneeAccountId?: string;
  parentKey?: string;
  extraFieldsJson?: string;
  dryRun?: boolean;
  confirm?: boolean;
}

interface JiraConfig {
  baseUrl?: string;
  projectKey?: string;
  issueType: string;
  apiVersion: "2"|"3";
  email?: string;
  apiToken?: string;
  bearerToken?: string;
  dryRunByDefault: boolean;
  allowNonInteractiveCreate: boolean;
}

interface PreparedJiraIssue {
  config: JiraConfig;
  dryRun: boolean;
  payload: {fields: Record<string, unknown>};
  requestUrl?: string;
  projectKey: string;
  issueType: string;
  summary: string;
}

interface JiraCreateResult {
  dryRun: boolean;
  cancelled?: boolean;
  key?: string;
  id?: string;
  self?: string;
  browseUrl?: string;
  response?: unknown;
  prepared: PreparedJiraIssue;
}

const CreateJiraTicketParams = Type.Object({
  summary : Type.String({description : "Short Jira issue summary/title"}),
  description : Type.Optional(
      Type.String({description : "Jira issue description in plain text"})),
  projectKey : Type.Optional(Type.String(
      {description : "Jira project key. Defaults to JIRA_PROJECT_KEY"})),
  issueType : Type.Optional(Type.String({
    description :
        `Jira issue type. Defaults to JIRA_ISSUE_TYPE or ${DEFAULT_ISSUE_TYPE}`
  })),
  labels : Type.Optional(Type.Array(
      Type.String(), {description : "Labels to attach to the issue"})),
  components : Type.Optional(Type.Array(
      Type.String(), {description : "Component names to attach to the issue"})),
  priority : Type.Optional(
      Type.String({description : "Priority name, for example High or Medium"})),
  assigneeAccountId : Type.Optional(
      Type.String({description : "Jira Cloud assignee accountId"})),
  parentKey : Type.Optional(Type.String(
      {description : "Parent issue key, for example an Epic or parent Task"})),
  extraFieldsJson : Type.Optional(
      Type.String({
        description :
            "JSON object merged into Jira fields for custom fields, for example {\"customfield_12345\":\"value\"}",
      }),
      ),
  dryRun : Type.Optional(Type.Boolean(
      {description : "Preview the Jira payload without creating an issue"})),
  confirm : Type.Optional(
      Type.Boolean({
        description :
            "Ask for interactive confirmation before creating. Defaults to true when UI is available"
      }),
      ),
});

function clean(value: string|undefined): string|undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function cleanBaseUrl(value: string|undefined): string|undefined {
  return clean(value)?.replace(/\/+$/, "");
}

function truthy(value: string|undefined): boolean {
  return [ "1", "true", "yes", "y", "on" ].includes(
      (value ?? "").trim().toLowerCase());
}

function truncate(value: string, maxChars = MAX_ERROR_CHARS): string {
  if (value.length <= maxChars)
    return value;
  return `${value.slice(0, maxChars)}… [truncated ${
      value.length - maxChars} chars]`;
}

function getConfig(projectKey?: string, issueType?: string): JiraConfig {
  const rawApiVersion =
      clean(process.env.JIRA_API_VERSION) ?? DEFAULT_API_VERSION;
  if (rawApiVersion !== "2" && rawApiVersion !== "3") {
    throw new Error(`JIRA_API_VERSION must be 2 or 3, got ${rawApiVersion}`);
  }

  return {
    baseUrl : cleanBaseUrl(process.env.JIRA_BASE_URL),
    projectKey : clean(projectKey) ?? clean(process.env.JIRA_PROJECT_KEY),
    issueType : clean(issueType) ?? clean(process.env.JIRA_ISSUE_TYPE) ??
                    DEFAULT_ISSUE_TYPE,
    apiVersion : rawApiVersion,
    email : clean(process.env.JIRA_EMAIL) ?? clean(process.env.JIRA_USERNAME),
    apiToken : clean(process.env.JIRA_API_TOKEN),
    bearerToken : clean(process.env.JIRA_BEARER_TOKEN),
    dryRunByDefault : truthy(process.env.JIRA_DRY_RUN),
    allowNonInteractiveCreate :
        truthy(process.env.JIRA_ALLOW_NON_INTERACTIVE_CREATE),
  };
}

function getMissingConfig(config: JiraConfig, requireAuth: boolean): string[] {
  const missing: string[] = [];
  if (!config.baseUrl)
    missing.push("JIRA_BASE_URL");
  if (!config.projectKey)
    missing.push("JIRA_PROJECT_KEY or projectKey");
  if (requireAuth && !config.bearerToken &&
      !(config.email && config.apiToken)) {
    missing.push("JIRA_BEARER_TOKEN or JIRA_EMAIL + JIRA_API_TOKEN");
  }
  return missing;
}

function getAuthHeaders(config: JiraConfig): Record<string, string> {
  if (config.bearerToken) {
    return {Authorization : `Bearer ${config.bearerToken}`};
  }
  if (config.email && config.apiToken) {
    const encoded = Buffer.from(`${config.email}:${config.apiToken}`, "utf8")
                        .toString("base64");
    return {Authorization : `Basic ${encoded}`};
  }
  throw new Error("Jira auth is not configured");
}

function cleanedList(values: string[]|undefined): string[] {
  return [...new Set(
      (values ?? []).map((value) => value.trim()).filter(Boolean)) ];
}

function textToAdf(text: string): Record<string, unknown> {
  const paragraphs = text.split(/\n{2,}/).map((paragraph) => {
    const content: Array<Record<string, string>> = [];
    for (const [index, line] of paragraph.split("\n").entries()) {
      if (index > 0)
        content.push({type : "hardBreak"});
      if (line)
        content.push({type : "text", text : line});
    }
    return {type : "paragraph", content};
  });

  return {
    type : "doc",
    version : 1,
    content : paragraphs.length > 0 ? paragraphs
                                    : [ {type : "paragraph", content : []} ],
  };
}

function parseExtraFields(extraFieldsJson: string|
                          undefined): Record<string, unknown> {
  const raw = clean(extraFieldsJson);
  if (!raw)
    return {};

  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("extraFieldsJson must parse to a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function buildPayload(params: CreateJiraTicketParams,
                      config: JiraConfig): {fields: Record<string, unknown>} {
  const summary = clean(params.summary);
  if (!summary)
    throw new Error("summary is required");
  if (!config.projectKey)
    throw new Error("Jira project key is required");

  const fields: Record<string, unknown> = {
    project : {key : config.projectKey},
    issuetype : {name : config.issueType},
    summary,
  };

  const description = clean(params.description);
  if (description) {
    fields.description =
        config.apiVersion === "3" ? textToAdf(description) : description;
  }

  const labels = cleanedList(params.labels);
  if (labels.length > 0)
    fields.labels = labels;

  const components = cleanedList(params.components);
  if (components.length > 0)
    fields.components = components.map((name) => ({name}));

  const priority = clean(params.priority);
  if (priority)
    fields.priority = {name : priority};

  const assigneeAccountId = clean(params.assigneeAccountId);
  if (assigneeAccountId)
    fields.assignee = {accountId : assigneeAccountId};

  const parentKey = clean(params.parentKey);
  if (parentKey)
    fields.parent = {key : parentKey};

  Object.assign(fields, parseExtraFields(params.extraFieldsJson));

  return {fields};
}

function prepareIssue(params: CreateJiraTicketParams): PreparedJiraIssue {
  const config = getConfig(params.projectKey, params.issueType);
  const dryRun = params.dryRun ?? config.dryRunByDefault;
  const missing = getMissingConfig(config, !dryRun);
  if (missing.length > 0) {
    throw new Error(
        `Jira extension is not configured: missing ${missing.join(", ")}`);
  }

  const payload = buildPayload(params, config);
  const summary = payload.fields.summary as string;
  const requestUrl =
      config.baseUrl ? `${config.baseUrl}/rest/api/${config.apiVersion}/issue`
                     : undefined;

  return {
    config,
    dryRun,
    payload,
    requestUrl,
    projectKey : config.projectKey!,
    issueType : config.issueType,
    summary,
  };
}

function parseJsonMaybe(text: string): unknown {
  if (!text)
    return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function getStringField(value: unknown, field: string): string|undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const maybe = (value as Record<string, unknown>)[field];
  return typeof maybe === "string" ? maybe : undefined;
}

function formatJiraErrors(body: unknown): string|undefined {
  if (!body || typeof body !== "object" || Array.isArray(body))
    return undefined;
  const record = body as Record<string, unknown>;
  const messages: string[] = [];

  if (Array.isArray(record.errorMessages)) {
    messages.push(...record.errorMessages.filter(
        (message): message is string => typeof message === "string"));
  }

  if (record.errors && typeof record.errors === "object" &&
      !Array.isArray(record.errors)) {
    for (const [field, message] of Object.entries(record.errors as
                                                  Record<string, unknown>)) {
      messages.push(`${field}: ${String(message)}`);
    }
  }

  return messages.length > 0 ? messages.join("; ") : undefined;
}

async function maybeConfirmCreate(prepared: PreparedJiraIssue,
                                  params: CreateJiraTicketParams,
                                  ctx: ExtensionContext): Promise<boolean> {
  if (prepared.dryRun)
    return true;

  if (ctx.hasUI && params.confirm !== false) {
    const description = [
      `Project: ${prepared.projectKey}`,
      `Type: ${prepared.issueType}`,
      `Summary: ${prepared.summary}`,
      prepared.requestUrl ? `Endpoint: ${prepared.requestUrl}` : undefined,
    ].filter(Boolean).join("\n");
    return ctx.ui.confirm("Create Jira ticket?", description);
  }

  if (!ctx.hasUI && !prepared.config.allowNonInteractiveCreate) {
    throw new Error(
        "Refusing to create Jira issue without interactive confirmation. Set dryRun=true or JIRA_ALLOW_NON_INTERACTIVE_CREATE=true.",
    );
  }

  return true;
}

async function createJiraIssue(
    params: CreateJiraTicketParams,
    signal: AbortSignal|undefined,
    ctx: ExtensionContext,
    ): Promise<JiraCreateResult> {
  const prepared = prepareIssue(params);
  const confirmed = await maybeConfirmCreate(prepared, params, ctx);
  if (!confirmed) {
    return {dryRun : prepared.dryRun, cancelled : true, prepared};
  }

  if (prepared.dryRun) {
    return {dryRun : true, prepared};
  }

  if (!prepared.requestUrl || !prepared.config.baseUrl) {
    throw new Error("JIRA_BASE_URL is required");
  }

  const response = await fetch(prepared.requestUrl, {
    method : "POST",
    headers : {
      "Content-Type" : "application/json",
      ...getAuthHeaders(prepared.config),
    },
    body : JSON.stringify(prepared.payload),
    signal,
  });

  const responseText = await response.text();
  const responseBody = parseJsonMaybe(responseText);

  if (!response.ok) {
    const jiraErrors = formatJiraErrors(responseBody);
    const bodyText = typeof responseBody === "string"
                         ? responseBody
                         : JSON.stringify(responseBody, null, 2);
    throw new Error(
        truncate(
            `Jira create issue failed (HTTP ${response.status} ${
                response.statusText}).${
                jiraErrors ? ` ${jiraErrors}.` : ""} Body: ${bodyText}`,
            ),
    );
  }

  const key = getStringField(responseBody, "key");
  const browseUrl =
      key ? `${prepared.config.baseUrl}/browse/${key}` : undefined;

  return {
    dryRun : false,
    key,
    id : getStringField(responseBody, "id"),
    self : getStringField(responseBody, "self"),
    browseUrl,
    response : responseBody,
    prepared,
  };
}

function formatToolResult(result: JiraCreateResult): string {
  if (result.cancelled)
    return "Cancelled: Jira issue was not created.";
  if (result.dryRun) {
    return `Dry run: Jira issue would be created in ${
        result.prepared.projectKey} as ${result.prepared.issueType}.`;
  }
  return `Created Jira issue ${result.key ?? "(unknown key)"}${
      result.browseUrl ? `: ${result.browseUrl}` : ""}`;
}

function notifyOrLog(ctx: ExtensionContext, message: string,
                     level: "info"|"warning"|"error" = "info") {
  if (ctx.hasUI) {
    ctx.ui.notify(message, level);
    return;
  }

  if (level === "error" || level === "warning") {
    console.error(message);
  } else {
    console.log(message);
  }
}

function safeConfigStatus(): {text: string; details : Record<string, unknown>} {
  try {
    const config = getConfig();
    const missingForCreate = getMissingConfig(config, true);
    const text = [
      "Jira extension configuration:",
      `- baseUrl: ${config.baseUrl ?? "missing"}`,
      `- projectKey: ${config.projectKey ?? "missing"}`,
      `- issueType: ${config.issueType}`,
      `- apiVersion: ${config.apiVersion}`,
      `- auth: ${
          config.bearerToken                ? "bearer token"
          : config.email && config.apiToken ? "email + API token"
                                            : "missing"}`,
      `- dryRunByDefault: ${config.dryRunByDefault}`,
      `- allowNonInteractiveCreate: ${config.allowNonInteractiveCreate}`,
      missingForCreate.length > 0
          ? `- missing for create: ${missingForCreate.join(", ")}`
          : "- ready: true",
    ].join("\n");

    return {
      text,
      details : {
        baseUrl : config.baseUrl,
        projectKey : config.projectKey,
        issueType : config.issueType,
        apiVersion : config.apiVersion,
        authConfigured :
            Boolean(config.bearerToken || (config.email && config.apiToken)),
        dryRunByDefault : config.dryRunByDefault,
        allowNonInteractiveCreate : config.allowNonInteractiveCreate,
        missingForCreate,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      text : `Jira extension configuration error: ${message}`,
      details : {error : message}
    };
  }
}

export default function jiraTicketExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name : "create_jira_ticket",
    label : "Create Jira Ticket",
    description :
        "Create a Jira issue using JIRA_* environment configuration. Returns the issue key and browse URL.",
    promptSnippet :
        "Create Jira issues from a summary and description using JIRA_* environment configuration",
    promptGuidelines : [
      "Use create_jira_ticket only when the user explicitly asks to create a Jira ticket or issue.",
      "Use create_jira_ticket with dryRun=true when drafting or previewing a ticket instead of creating it.",
    ],
    parameters : CreateJiraTicketParams,
    async execute(_toolCallId, params: CreateJiraTicketParams, signal,
                  _onUpdate, ctx) {
      const result = await createJiraIssue(params, signal, ctx);
      return {
        content : [ {type : "text", text : formatToolResult(result)} ],
        details : {
          dryRun : result.dryRun,
          cancelled : result.cancelled,
          key : result.key,
          id : result.id,
          self : result.self,
          browseUrl : result.browseUrl,
          projectKey : result.prepared.projectKey,
          issueType : result.prepared.issueType,
          payload : result.prepared.payload,
          response : result.response,
        },
      };
    },
  });

  pi.registerTool({
    name : "jira_config",
    label : "Jira Config",
    description :
        "Check Jira extension configuration without revealing secrets.",
    promptSnippet : "Check whether Jira ticket creation is configured",
    parameters : Type.Object({}),
    async execute() {
      const status = safeConfigStatus();
      return {
        content : [ {type : "text", text : status.text} ],
        details : status.details
      };
    },
  });

  pi.registerCommand("jira-create", {
    description :
        "Create a Jira ticket. Usage: /jira-create [--dry-run] <summary>",
    handler : async (args, ctx) => {
      let summary = args.trim();
      let dryRun = false;
      if (summary === "--dry-run" || summary.startsWith("--dry-run ")) {
        dryRun = true;
        summary = summary.replace(/^--dry-run\s*/, "").trim();
      }

      if (!summary && ctx.hasUI) {
        summary =
            (await ctx.ui.input("Jira summary", "Short issue title"))?.trim() ??
            "";
      }

      if (!summary) {
        notifyOrLog(ctx, "Jira summary is required", "warning");
        return;
      }

      const description =
          ctx.hasUI ? ((await ctx.ui.editor("Jira description", "")) ?? "")
                    : "";

      try {
        const result = await createJiraIssue({summary, description, dryRun},
                                             undefined, ctx);
        notifyOrLog(ctx, formatToolResult(result),
                    result.cancelled ? "warning" : "info");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        notifyOrLog(ctx, `Jira ticket creation failed: ${message}`, "error");
      }
    },
  });

  pi.registerCommand("jira-config", {
    description : "Show Jira extension configuration status",
    handler : async (_args, ctx) => {
      const status = safeConfigStatus();
      if (ctx.hasUI) {
        await ctx.ui.confirm("Jira configuration", status.text);
      } else {
        console.log(status.text);
      }
    },
  });
}
