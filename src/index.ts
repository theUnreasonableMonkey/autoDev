#!/usr/bin/env node

import { Command } from "commander";

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
    console.log("AutoDev starting...");
    console.log(`Config: ${options.config}`);
    if (options.resume) console.log("Resuming from saved state...");
    if (options.dryRun) console.log("Dry run mode — no changes will be made.");

    // TODO: Wire up config loader, state machine, and issue fetching
    console.log("\n⚠️  Not yet implemented. Phase 1 scaffolding complete.");
  });

program
  .command("status")
  .description("Show current orchestrator progress")
  .action(() => {
    // TODO: Read state.json and display progress
    console.log("Status command not yet implemented.");
  });

program
  .command("reset")
  .description("Clear saved state and start fresh")
  .action(() => {
    // TODO: Delete state.json with confirmation
    console.log("Reset command not yet implemented.");
  });

program.parse();
