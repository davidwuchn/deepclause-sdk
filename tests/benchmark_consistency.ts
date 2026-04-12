import { createDeepClause } from '../src/sdk.js';
import { calculateConsistencyMetrics } from './stats.js';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Mock GAIA-style tasks for demonstration.
 * In a real scenario, you would load these from a JSONL/Parquet file.
 */
const TASKS = [
  {
    id: "level1_1",
    question: "What is the capital of France?",
    groundTruth: "Paris"
  },
  {
    id: "level1_2",
    question: "Calculate the square root of 144 plus 50.",
    groundTruth: "62"
  },
  {
    id: "level2_1",
    question: "Search for the current price of Bitcoin and tell me if it is above $50,000.",
    groundTruth: "yes" // Assuming current market
  },
  {
    id: "level2_2",
    question: "Write a python script to find the 10th fibonacci number.",
    groundTruth: "55"
  }
];

const TRIALS = 4; // Use 8 or 64 for real research, 4 for speed here.

async function runBenchmark() {
  const dmlPath = path.join(process.cwd(), 'tests', 'consistency_agent.dml');
  const dmlCode = fs.readFileSync(dmlPath, 'utf8');

  const dc = await createDeepClause({
    model: process.env.MODEL || 'gpt-4o-mini',
  });

  console.log(`
🚀 Starting Consistency Benchmark`);
  console.log(`Tasks: ${TASKS.length}, Trials per Task: ${TRIALS}`);
  console.log(`Model: ${process.env.MODEL || 'gpt-4o-mini'}
`);

  const resultsMatrix: number[][] = [];

  for (let i = 0; i < TASKS.length; i++) {
    const task = TASKS[i];
    resultsMatrix[i] = [];
    
    console.log(`[Task ${i + 1}/${TASKS.length}] ${task.id}: "${task.question.substring(0, 40)}..."`);

    for (let t = 0; t < TRIALS; t++) {
      process.stdout.write(`  Trial ${t + 1}/${TRIALS}: `);
      
      try {
        let agentAnswer = "";
        
        // Execute the DML agent
        for await (const event of dc.runDML(dmlCode, { params: { Question: task.question } })) {
          if (event.type === 'answer' && typeof event.content === 'string') {
            agentAnswer = event.content;
          }
        }

        // Grading logic (using a simple heuristic or LLM judge)
        // For this demo, we check if ground truth is in the answer
        const isCorrect = agentAnswer.toLowerCase().includes(task.groundTruth.toLowerCase()) ? 1 : 0;
        
        resultsMatrix[i].push(isCorrect);
        console.log(isCorrect === 1 ? "✅ SUCCESS" : "❌ FAIL");
      } catch (error) {
        console.log(`💥 ERROR: ${(error as Error).message}`);
        resultsMatrix[i].push(0);
      }
    }
  }

  // Calculate Metrics
  const metrics = calculateConsistencyMetrics(resultsMatrix);

  console.log(`
${"=".repeat(50)}`);
  console.log(`CONSISTENCY EVALUATION CARD`);
  console.log(`${"=".repeat(50)}`);
  console.log(`Accuracy:          ${(metrics.accuracy * 100).toFixed(1)}% ± ${( (metrics.confidenceInterval[1] - metrics.accuracy) * 100).toFixed(1)}%`);
  console.log(`Consistency (ICC): ${metrics.icc.toFixed(3)}`);
  console.log(`Between-Query SE:  ${metrics.betweenQuerySE.toFixed(3)}`);
  console.log(`${"=".repeat(50)}`);

  if (metrics.icc >= 0.75) {
    console.log("Verdict: GOOD RELIABILITY. Differences in performance are due to task difficulty.");
  } else if (metrics.icc >= 0.50) {
    console.log("Verdict: MODERATE RELIABILITY. The agent is somewhat stochastic.");
  } else {
    console.log("Verdict: POOR RELIABILITY. The agent's performance is highly inconsistent.");
  }

  await dc.dispose();
}

runBenchmark().catch(console.error);
