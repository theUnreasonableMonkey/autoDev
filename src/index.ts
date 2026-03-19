#!/usr/bin/env node

import { Command } from "commander";
import { randomUUID } from "node:crypto";
import { loadConfig } from "./config/loader.js";
import { fetchIssues } from "./github/issues.js";
import { createWorkflowMachine } from "./machine/workflow.js";
import { persistSnapshot, loadSnapshot, hasSnapshot, clearSnapshot } from "./machine/persistence.js";
import { createActor } from "xstate";

const program = new Command();

program
  .name("autodev")
  .description("Automated development orchestrator — works GitHub issues end-to-end using AI")
  .version("0.1.0");

program
  .command("start")
  .description("Start processing issues from the configured queue")
  .option("-c, --config <path>", "Path to config file", "autodev.config.yaml")
  .option("--resume", "Resume from last saved state")
  .option("--dry-run", "Fetch and display issues without processing them")
  .action(async (options: { config: string; resume?: boolean; dryRun?: boolean }) => {
    try {
      // Load and validate config
      const config = loadConfig(options.config);
      console.log(`Loaded config for repo: ${config.repo}`);

      // Dry-run mode: fetch and display issues, then exit
      if (options.dryRun) {
        console.log("\n--- DRY RUN ---\n");
        console.log("Fetching issues...");
        const issues = await fetchIssues(config);

        if (issues.length === 0) {
          console.log("No matching issues found.");
          return;
        }

        console.log(`Found ${issues.length} issue(s):\n`);
        for (const issue of issues) {
          const labels = issue.labels.join(", ");
          console.log(`  #${issue.number} — ${issue.title} [${labels}]`);
          console.log(`    ${issue.url}`);
        }

        console.log(`\nReviewer: ${config.reviewer.type}`);
        console.log(`Max review iterations: ${config.reviewer.max_iterations}`);
        console.log(`Max questions per issue: ${config.issues.max_questions_per_issue}`);
        console.log("\nRun without --dry-run to start processing.");
        return;
      }

      // Resume mode: restore state from disk
      const runId = randomUUID().slice(0, 8);
      const machine = createWorkflowMachine(config);

      if (options.resume) {
        const snapshot = loadSnapshot();
        if (!snapshot) {
          console.error("No saved state found. Run without --resume to start fresh.");
          process.exit(1);
        }
        console.log("Resuming from saved state...");
        const actor = createActor(machine, { snapshot });

        // Persist on every state change
        actor.subscribe(() => {
          const persisted = actor.getPersistedSnapshot();
          persistSnapshot(persisted);
        });

        actor.start();
        console.log(`Resumed. Current state: ${JSON.stringify(actor.getSnapshot().value)}`);

        // TODO: In later phases, this will block until the machine reaches 'complete'
        // For now, we just show the state
        return;
      }

      // Normal start
      console.log(`Starting run ${runId}...`);
      const actor = createActor(machine);

      // Persist on every state change
      actor.subscribe(() => {
        const persisted = actor.getPersistedSnapshot();
        persistSnapshot(persisted);
      });

      // Graceful shutdown
      const shutdown = () => {
        console.log("\nShutdown requested. Persisting state...");
        const persisted = actor.getPersistedSnapshot();
        persistSnapshot(persisted);
        console.log("State saved. Run with --resume to continue.");
        process.exit(0);
      };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);

      actor.start();
      actor.send({ type: "START" });

      console.log(`State: ${JSON.stringify(actor.getSnapshot().value)}`);
      console.log(
        "\nNote: Full execution loop not yet wired. " +
          "The state machine is running with stub actors.",
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Error: ${message}`);
      process.exit(1);
    }
  });

program
  .command("status")
  .description("Show current orchestrator progress")
  .action(() => {
    if (!hasSnapshot()) {
      console.log("No active run. State file not found.");
      return;
    }
    const snapshot = loadSnapshot();
    if (!snapshot) {
      console.log("Failed to read state file.");
      return;
    }
    const data = snapshot as unknown as { value?: unknown; context?: Record<string, unknown> };
    console.log("Current state:", JSON.stringify(data.value));
    const context = data.context;
    if (context) {
      console.log(`Run ID: ${context["runId"]}`);
      console.log(`Issues in queue: ${(context["issues"] as unknown[])?.length ?? 0}`);
      console.log(`Current issue index: ${context["currentIssueIndex"]}`);
      console.log(`Completed: ${(context["completedIssues"] as unknown[])?.length ?? 0}`);
      console.log(`Skipped: ${(context["skippedIssues"] as unknown[])?.length ?? 0}`);
    }
  });

program
  .command("reset")
  .description("Clear saved state and start fresh")
  .action(() => {
    if (clearSnapshot()) {
      console.log("State cleared. Ready for a fresh run.");
    } else {
      console.log("No state file found. Nothing to reset.");
    }
  });

program.parse();
