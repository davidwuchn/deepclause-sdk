/**
 * Statistical utilities for agent consistency benchmarking.
 * Implements ICC(1,1) - One-way random effects model.
 */

export interface BenchmarkMetrics {
  accuracy: number;
  icc: number;
  betweenQuerySE: number;
  confidenceInterval: [number, number];
}

/**
 * Calculates ICC(1,1) from a matrix of results.
 * @param matrix - [TaskIndex][TrialIndex] where value is 0 or 1.
 */
export function calculateConsistencyMetrics(matrix: number[][]): BenchmarkMetrics {
  const n = matrix.length; // Number of tasks (queries)
  const k = matrix[0].length; // Number of trials per task
  const N = n * k; // Total number of observations

  // 1. Calculate Accuracy
  let sum = 0;
  for (const row of matrix) {
    for (const val of row) {
      sum += val;
    }
  }
  const accuracy = sum / N;

  // 2. ANOVA calculations for ICC
  // Mean of each task
  const taskMeans = matrix.map(row => row.reduce((a, b) => a + b, 0) / k);
  
  // Grand Mean
  const grandMean = accuracy;

  // Sum of Squares Between (SSB)
  let ssb = 0;
  for (const m_i of taskMeans) {
    ssb += Math.pow(m_i - grandMean, 2);
  }
  ssb *= k;

  // Sum of Squares Within (SSW)
  let ssw = 0;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < k; j++) {
      ssw += Math.pow(matrix[i][j] - taskMeans[i], 2);
    }
  }

  // Mean Squares
  const msb = ssb / (n - 1);
  const msw = ssw / (n * (k - 1));

  // ICC(1,1) Formula: (MSB - MSW) / (MSB + (k-1) * MSW)
  // If MSW is 0 (perfect consistency), ICC is 1.
  // If MSB is less than MSW, we set ICC to 0 (no correlation).
  let icc = 0;
  if (msb > msw) {
    icc = (msb - msw) / (msb + (k - 1) * msw);
  } else if (msb === msw && msb === 0) {
    icc = 1.0; // All zero or all one
  }

  // 3. Standard Error & Confidence Intervals
  // Simplification for binary outcomes (Standard Error of Mean)
  const se = Math.sqrt((accuracy * (1 - accuracy)) / N);
  const marginOfError = 1.96 * se;

  // Between-query SE (Standard deviation of task means / sqrt(n))
  const taskMeanVariance = taskMeans.reduce((acc, m) => acc + Math.pow(m - grandMean, 2), 0) / (n - 1);
  const betweenQuerySE = Math.sqrt(taskMeanVariance / n);

  return {
    accuracy,
    icc,
    betweenQuerySE,
    confidenceInterval: [accuracy - marginOfError, accuracy + marginOfError]
  };
}
