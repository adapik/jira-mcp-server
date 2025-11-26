import { z } from "zod";
import { $jiraJson } from "../utils/jira-fetch.ts";
import { err, ok } from "neverthrow";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { env } from "../env.js";

// @see https://developer.atlassian.com/server/jira/platform/rest/v10004/api-group-board/#api-agile-1-0-board-boardid-sprint-sprintid-issue-get

// Minimal schema for CSV output - only the fields we need
const minimalIssueSchema = z.object({
  key: z.string(),
  fields: z.object({
    summary: z.string().optional(),
    status: z
      .object({
        name: z.string(),
      })
      .nullable()
      .optional(),
    assignee: z
      .object({
        displayName: z.string(),
      })
      .nullable()
      .optional(),
    created: z.string(),
    timeoriginalestimate: z.number().nullable().optional(),
    fixVersions: z
      .array(
        z.object({
          name: z.string(),
        }),
      )
      .optional(),
    issuetype: z
      .object({
        name: z.string(),
      })
      .nullable()
      .optional(),
    labels: z.array(z.string()).optional(),
    parent: z
      .object({
        key: z.string(),
      })
      .nullable()
      .optional(),
  }),
});

const listIssuesFromSprintCsvResponseSchema = z.object({
  issues: z.array(minimalIssueSchema),
});

export const listIssuesFromSprintCsvInputSchema = z.object({
  sprintId: z.string().describe("The ID of the sprint"),
  boardId: z.string().describe("The ID of the board"),
  maxResults: z
    .number()
    .optional()
    .describe(
      "The maximum number of results to return, (default: 50, max: 100)",
    ),
  startAt: z
    .number()
    .optional()
    .describe("The starting index of the returned issues"),
});

export const LIST_ISSUES_FROM_SPRINT_CSV_TOOL: Tool = {
  name: "list_issues_from_sprint_csv",
  description:
    "List issues from a sprint in compact CSV format (key, summary, type, status, assignee, created, original estimate in hours, fix versions, hotfix, parent_id). Reduces token usage compared to full JSON response.",
  inputSchema: zodToJsonSchema(
    listIssuesFromSprintCsvInputSchema,
  ) as Tool["inputSchema"],
};

export type ListIssuesFromSprintCsvInput = z.output<
  typeof listIssuesFromSprintCsvInputSchema
>;

function escapeCSV(value: string | undefined | null): string {
  if (!value) return "";
  // Escape quotes and wrap in quotes if contains comma, quote, or newline
  if (value.includes(",") || value.includes('"') || value.includes("\n")) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export async function listIssuesFromSprintCsv(
  input: ListIssuesFromSprintCsvInput,
) {
  const url = new URL(
    `/rest/agile/1.0/board/${input.boardId}/sprint/${input.sprintId}/issue`,
    env.JIRA_BASE_URL,
  );

  // Only request the fields we need to minimize response size
  url.searchParams.set("fields", "summary,status,assignee,created,timeoriginalestimate,fixVersions,issuetype,labels,parent");

  if (input.startAt) url.searchParams.set("startAt", input.startAt.toString());
  if (input.maxResults)
    url.searchParams.set("maxResults", input.maxResults.toString());

  const json = await $jiraJson(url.toString());

  if (json.isErr()) return err(json.error);

  const result = listIssuesFromSprintCsvResponseSchema.safeParse(json.value);

  if (!result.success) {
    return err(new Error("Invalid response from Jira"));
  }

  // Convert to CSV format
  const header = "Key,Summary,Type,Status,Assignee,Created,Original Estimate (hours),Fix Versions,Hotfix,Parent ID";
  const rows = result.data.issues.map((issue) => {
    const key = escapeCSV(issue.key);
    const summary = escapeCSV(issue.fields.summary);
    const type = escapeCSV(issue.fields.issuetype?.name);
    const status = escapeCSV(issue.fields.status?.name);
    const assignee = escapeCSV(issue.fields.assignee?.displayName);
    const created = escapeCSV(issue.fields.created);
    // Convert seconds to hours and format with 2 decimal places
    const originalEstimateHours = issue.fields.timeoriginalestimate
      ? (issue.fields.timeoriginalestimate / 3600).toFixed(2)
      : "";
    // Join multiple fix versions with semicolon if there are multiple
    const fixVersions = issue.fields.fixVersions
      ? escapeCSV(issue.fields.fixVersions.map((v) => v.name).join("; "))
      : "";
    // Check if issue has Hotfix or HotFix label (case-insensitive)
    const isHotfix = issue.fields.labels?.some(
      (label) => label.toLowerCase() === "hotfix",
    )
      ? "1"
      : "0";
    const parentId = escapeCSV(issue.fields.parent?.key);

    return `${key},${summary},${type},${status},${assignee},${created},${originalEstimateHours},${fixVersions},${isHotfix},${parentId}`;
  });

  const csv = [header, ...rows].join("\n");

  return ok(csv);
}