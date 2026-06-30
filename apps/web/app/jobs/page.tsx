"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useListJobsQuery, type Job } from "../../src/store/api";

const statusColors: Record<Job["status"], string> = {
  running: "bg-blue-500",
  completed: "bg-green-500",
  stopped: "bg-amber-500",
  failed: "bg-red-500",
};

function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

// Tradeoff: rather than spinning up a per-row polling subscription for every
// running job (one extra GET per running row every few seconds), we poll the
// single list endpoint. The backend's list response already includes
// pagesCrawled, so one request refreshes every running row's page count at
// once — cheaper and simpler than N per-row queries. We only poll while at
// least one row is running, and stop once all jobs are terminal.
const LIST_POLL_MS = 3000;

function JobDuration({ job, now }: { job: Job; now: number }) {
  if (job.completedAt) {
    const ms = new Date(job.completedAt).getTime() - new Date(job.startedAt).getTime();
    return <>{formatDuration(ms)}</>;
  }
  if (job.status === "running") {
    // Live elapsed time for running jobs, ticking via the `now` clock.
    return <>{formatDuration(now - new Date(job.startedAt).getTime())}</>;
  }
  return <>—</>;
}

export default function JobsListPage() {
  const router = useRouter();

  // `now` drives the live elapsed-time display for running jobs.
  const [now, setNow] = useState(() => 0);
  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // Single list subscription; poll only while at least one job is running and
  // stop (interval 0) once every job is terminal — same single-subscription
  // pattern as the status page, so we never poll a fully-settled history.
  const [pollingInterval, setPollingInterval] = useState(LIST_POLL_MS);
  const { data, isLoading, error } = useListJobsQuery(undefined, {
    pollingInterval,
  });

  const jobs = data?.jobs ?? [];
  const hasRunning = jobs.some((job) => job.status === "running");

  useEffect(() => {
    setPollingInterval(hasRunning ? LIST_POLL_MS : 0);
  }, [hasRunning]);

  if (isLoading) {
    return (
      <div className="min-h-screen bg-slate-900 text-white flex items-center justify-center">
        <p className="text-slate-400">Loading jobs...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen bg-slate-900 text-white flex items-center justify-center">
        <p className="text-red-400">Failed to load jobs</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-900 text-white p-6">
      <div className="mx-auto w-full max-w-4xl space-y-6">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold">Job History</h1>
          <a
            href="/jobs/new"
            className="bg-blue-600 hover:bg-blue-500 rounded px-4 py-2 text-sm font-medium transition-colors"
          >
            + New crawl
          </a>
        </div>

        {jobs.length === 0 ? (
          <div className="bg-slate-800 rounded p-12 text-center">
            <p className="text-slate-400">No jobs yet.</p>
            <a
              href="/jobs/new"
              className="mt-2 inline-block text-sm text-blue-400 hover:text-blue-300"
            >
              Start your first crawl →
            </a>
          </div>
        ) : (
          <div className="overflow-x-auto rounded border border-slate-800">
            <table className="w-full text-left text-sm">
              <thead className="bg-slate-800 text-slate-400">
                <tr>
                  <th className="px-4 py-3 font-medium">Seed URL</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                  <th className="px-4 py-3 font-medium">Pages</th>
                  <th className="px-4 py-3 font-medium">Started</th>
                  <th className="px-4 py-3 font-medium">Duration</th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((job) => (
                  <tr
                    key={job.jobId}
                    onClick={() => router.push(`/jobs/${job.jobId}`)}
                    className="cursor-pointer border-t border-slate-800 hover:bg-slate-800/50 transition-colors"
                  >
                    <td className="px-4 py-3 max-w-xs truncate" title={job.seedUrl}>
                      {job.seedUrl}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`px-2 py-1 rounded-full text-xs font-semibold uppercase ${statusColors[job.status]}`}
                      >
                        {job.status}
                      </span>
                    </td>
                    <td className="px-4 py-3">{job.pagesCrawled}</td>
                    <td className="px-4 py-3 text-slate-400">
                      {new Date(job.startedAt).toLocaleString()}
                    </td>
                    <td className="px-4 py-3 text-slate-400">
                      <JobDuration job={job} now={now} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
