"use client";

import { use, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useGetJobQuery, useStopJobMutation } from "../../../src/store/api";

const statusColors: Record<string, string> = {
  running: "bg-blue-500",
  completed: "bg-green-500",
  stopped: "bg-amber-500",
  failed: "bg-red-500",
};

export default function JobStatusPage({
  params,
}: {
  params: Promise<{ jobId: string }>;
}) {
  const { jobId } = use(params);
  const router = useRouter();

  // A single useGetJobQuery subscription whose pollingInterval is derived from
  // the job status. We can't reference the query result before the hook runs,
  // so the interval is held in state and updated in an effect once we know the
  // status. Driving the *same* subscription's interval (rather than adding a
  // second subscriber) is what actually stops the polling: with two
  // subscribers RTK Query would keep polling at the lowest non-zero interval.
  // Setting it to 0 once the status is terminal disables polling entirely.
  const [pollingInterval, setPollingInterval] = useState(3000);
  const { data: job, isLoading, error } = useGetJobQuery(jobId, {
    pollingInterval,
  });

  const isTerminal =
    job?.status === "completed" ||
    job?.status === "stopped" ||
    job?.status === "failed";

  useEffect(() => {
    setPollingInterval(isTerminal ? 0 : 3000);
  }, [isTerminal]);

  const [stopJob] = useStopJobMutation();

  // The backend stop is asynchronous: DELETE returns "stop signal sent" while
  // the job still reads `running` until a later poll catches the flip to
  // `stopped`. We track the request locally so the button shows "Stopping…"
  // from click right through that window, rather than only during the DELETE.
  const [stopRequested, setStopRequested] = useState(false);

  const isRunning = job?.status === "running";

  async function handleStop() {
    setStopRequested(true);
    try {
      await stopJob(jobId).unwrap();
    } catch {
      // Stop failed — let the user try again.
      setStopRequested(false);
    }
  }

  if (isLoading) {
    return (
      <div className="min-h-screen bg-slate-900 text-white flex items-center justify-center">
        <p className="text-slate-400">Loading job...</p>
      </div>
    );
  }

  if (error || !job) {
    return (
      <div className="min-h-screen bg-slate-900 text-white flex items-center justify-center">
        <p className="text-red-400">Job not found</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-900 text-white flex items-center justify-center p-6">
      <div className="w-full max-w-md space-y-6">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold">Job Status</h1>
          <span
            className={`px-3 py-1 rounded-full text-xs font-semibold uppercase ${statusColors[job.status]}`}
          >
            {job.status}
          </span>
        </div>

        <div className="space-y-3 bg-slate-800 rounded p-4">
          <div>
            <p className="text-xs text-slate-400">Seed URL</p>
            <p className="text-sm break-all">{job.seedUrl}</p>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <p className="text-xs text-slate-400">Pages Crawled</p>
              <p className="text-lg font-semibold">{job.pagesCrawled}</p>
            </div>
            {job.queueSize !== undefined && (
              <div>
                <p className="text-xs text-slate-400">Queue Size</p>
                <p className="text-lg font-semibold">{job.queueSize}</p>
              </div>
            )}
          </div>
          <div>
            <p className="text-xs text-slate-400">Started At</p>
            <p className="text-sm">{new Date(job.startedAt).toLocaleString()}</p>
          </div>
          {job.completedAt && (
            <div>
              <p className="text-xs text-slate-400">Completed At</p>
              <p className="text-sm">{new Date(job.completedAt).toLocaleString()}</p>
            </div>
          )}
          {job.error && (
            <div>
              <p className="text-xs text-slate-400">Error</p>
              <p className="text-sm text-red-400">{job.error}</p>
            </div>
          )}
        </div>

        {isRunning && (
          <button
            onClick={handleStop}
            disabled={stopRequested}
            className="w-full bg-red-600 hover:bg-red-500 disabled:bg-slate-700 disabled:text-slate-400 rounded px-4 py-2 font-medium transition-colors"
          >
            {stopRequested ? "Stopping..." : "Stop crawl"}
          </button>
        )}

        <button
          onClick={() => router.push("/jobs")}
          className="w-full bg-slate-800 hover:bg-slate-700 rounded px-4 py-2 font-medium transition-colors"
        >
          View all jobs
        </button>
      </div>
    </div>
  );
}