## John’s Prompt: 
I want to build a tool of some sort that will automate my development process.  Currently, I brainstorm my ideas, turn them into issues in my repo, create a sequence list to ensure we execute the issues one at a time, and then work through them one at a time.  I use claude code (CLI) with dangerously-skip-permissions which helps.  I also use /slfg from compound engineering which further helps along with the ralph-loop skill.  However, for each issue, I have to answer questions (often, but not always) and then run an independent reviewer session, followed by responding to the reviewer session and giving follow on instructions (which are always the same - "complete the P1 and P2 issues and triage any remaining issues and add them to the to-do list).  then I commit and push the code.  I usually do 2-3 iterations of workflows:review (compound-engineering from every.to) and then commit, push, merge, pull from main, find the next issue in the sequence list, and issue a /workflows:work or /slfg command to start working on the next issue.  and then I repeat for all open issues in the repo.
I'd like to create a skill, mcp server, api, or something that allows me to point at a set of issues in a repo (maybe curate the specific list and order) and then just have claude code work them until they're done.  if I run out of credits on my max pro account, I'd like the solution to know to wait and then resume work when my usage limit(s) have reset.  
Thoughts?
## Gemini’s Answer:
This is a classic "Agentic Workflow" problem. You’ve already optimized the inner loop (the coding itself) with Claude Code and Compound Engineering's skills; now you're looking to build the outer loop orchestrator.
Since Claude Code is a CLI tool designed for interactive use, the most effective way to automate it without fighting its internal logic is to build a Wrapper Orchestrator that treats the CLI as a subprocess.
Here is a breakdown of how you can build this "Auto-Pilot" layer.
________________________________________
1. The Architecture: The "Controller" Script
An MCP server is great for giving Claude new tools, but it isn't designed to "drive" the CLI. Instead, you need a Node.js or Python script that acts as the conductor.
Recommended Stack:
•	Language: Node.js (since Claude Code is Node-based).
•	Library: node-pty (to handle the interactive terminal/TTY) or zx (for simpler shell scripting).
•	GitHub CLI (gh): To programmatically fetch issues and handle PRs.
________________________________________
2. Automating the Workflow Logic
Your script should follow a state machine logic to handle the transitions you currently do manually.
The Loop Logic:
1.	Fetch Issue: Use gh issue list --label "next-up" or read from a sequence.json.
2.	Initialize Claude: Spawn a Claude Code session with claude --dangerously-skip-permissions.
3.	Inject Command: Send /slfg work on issue #123.
4.	The "Reviewer" Pivot:
o	Monitor the stdout for the completion of the work phase.
o	When the prompt returns, send /workflows:review.
5.	Standardized Responses:
o	When the reviewer finishes, the script detects the pause and automatically sends your boilerplate: "complete the P1 and P2 issues and triage any remaining issues..."
6.	Git Operations: Once the task is "Done," the script executes git add, git commit -m "...", and gh pr create.
________________________________________
3. Handling Usage Limits (The "Wait and Resume" Logic)
Since Anthropic doesn't currently expose a "Remaining Quota" endpoint for the CLI, you have to handle this via String Matching.
1.	Detection: Your script monitors the terminal output for strings like Usage limit reached, Try again in..., or 429 Too Many Requests.
2.	Pause: If detected, the script parses the "reset time" (if provided) or defaults to a 1-hour sleep.
3.	Persistence: The script saves the current issue_id and state (e.g., "Reviewing") to a local recovery.json.
4.	Resume: After the sleep timer expires, the script restarts the process from the last saved state.
________________________________________
4. Drafting the "Orchestrator" (Conceptual Example)
You could create a file named auto-claude.js. Here is a high-level look at how that subprocess interaction looks:
JavaScript
import pty from 'node-pty';

const issues = ['#1', '#2', '#3'];

async function runWorkflow(issueId) {
  const claude = pty.spawn('claude', ['--dangerously-skip-permissions'], {
    name: 'xterm-color',
    cols: 80,
    rows: 30,
  });

  claude.onData(data => {
    process.stdout.write(data);
    
    // 1. Detect if Claude is asking a question
    if (data.includes('?')) {
      // You could potentially pipe this to a "Manager" AI to answer
      // or pause for manual input.
    }

    // 2. Automate the Reviewer sequence
    if (data.includes('Task complete. What next?')) {
      claude.write('/workflows:review\n');
    }

    // 3. Handle Rate Limits
    if (data.includes('Usage limit reached')) {
      console.log("Rate limit hit. Sleeping for 1 hour...");
      // Logic to kill process and set a restart timer
    }
  });
}
________________________________________
5. Enhancing with a Custom MCP Server
While the wrapper handles the "driving," an MCP Server can help Claude manage its own queue. You could build a simple "Queue MCP" with two tools:
•	get_next_task: Reads your sequence.json.
•	mark_task_complete: Updates the status of the issue in GitHub.
This allows Claude to know what it is doing, while your wrapper script handles when it is doing it.
Why this works:
•	Resilience: If the CLI crashes, your wrapper script remains alive to restart it.
•	Standardization: You never forget to run the reviewer or the triage instructions.
•	Scalability: You can leave this running overnight on a dedicated terminal or a cheap VPS.
A word of caution: Using dangerously-skip-permissions in a fully automated loop is powerful but risky. Ensure your .claudeignore is rock solid so the model doesn't accidentally overwrite your automation script or delete your .git folder while you're asleep!
Does this "Wrapper Orchestrator" approach align with what you were thinking, or were you hoping for something more internal to the Claude Code skills system?

