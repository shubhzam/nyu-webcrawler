"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useStartJobMutation } from "../../../src/store/api";

export default function NewJobPage() {
  const router = useRouter();
  const [startJob, { isLoading, error }] = useStartJobMutation();

  const [url, setUrl] = useState("");
  const [maxDepth, setMaxDepth] = useState(3);
  const [maxPages, setMaxPages] = useState(100);
  const [crawlDelay, setCrawlDelay] = useState(2);
  const [urlError, setUrlError] = useState("");

  function validateUrl(value: string): boolean {
    try {
      const parsed = new URL(value);
      return parsed.protocol === "http:" || parsed.protocol === "https:";
    } catch {
      return false;
    }
  }

  async function handleSubmit() {
    setUrlError("");

    if (!validateUrl(url)) {
      setUrlError("must be a valid http or https URL");
      return;
    }

    try {
      const result = await startJob({ url, maxDepth, maxPages, crawlDelay }).unwrap();
      router.push(`/jobs/${result.jobId}`);
    } catch {
      // error displayed via the `error` state from RTK Query
    }
  }

  return (
    <div className="min-h-screen bg-slate-900 text-white flex items-center justify-center p-6">
      <div className="w-full max-w-md space-y-6">
        <h1 className="text-2xl font-bold">Start a crawl</h1>

        {/* url input */}
        <div className="space-y-1">
          <label className="text-sm text-slate-400">Seed URL</label>
          <input
            type="text"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://example.com"
            className="w-full bg-slate-800 border border-slate-700 rounded px-3 py-2 text-white placeholder-slate-500 focus:outline-none focus:border-blue-500"
          />
          {urlError && <p className="text-red-400 text-sm">{urlError}</p>}
        </div>

        {/* max depth */}
        <div className="space-y-1">
          <label className="text-sm text-slate-400">Max Depth: {maxDepth}</label>
          <input
            type="range"
            min={1}
            max={10}
            value={maxDepth}
            onChange={(e) => setMaxDepth(Number(e.target.value))}
            className="w-full accent-blue-500"
          />
          <div className="flex justify-between text-xs text-slate-500">
            <span>1</span><span>10</span>
          </div>
        </div>

        {/* max pages */}
        <div className="space-y-1">
          <label className="text-sm text-slate-400">Max Pages: {maxPages}</label>
          <input
            type="range"
            min={10}
            max={500}
            step={10}
            value={maxPages}
            onChange={(e) => setMaxPages(Number(e.target.value))}
            className="w-full accent-blue-500"
          />
          <div className="flex justify-between text-xs text-slate-500">
            <span>10</span><span>500</span>
          </div>
        </div>

        {/* crawl delay */}
        <div className="space-y-1">
          <label className="text-sm text-slate-400">Crawl Delay: {crawlDelay}s</label>
          <input
            type="range"
            min={0}
            max={10}
            value={crawlDelay}
            onChange={(e) => setCrawlDelay(Number(e.target.value))}
            className="w-full accent-blue-500"
          />
          <div className="flex justify-between text-xs text-slate-500">
            <span>0s</span><span>10s</span>
          </div>
        </div>

        {/* api error */}
        {error && (
          <p className="text-red-400 text-sm">
            {"data" in error
              ? (error.data as { error?: { message?: string } })?.error?.message ?? "something went wrong"
              : "something went wrong"}
          </p>
        )}

        <button
          onClick={handleSubmit}
          disabled={isLoading}
          className="w-full bg-blue-600 hover:bg-blue-500 disabled:bg-slate-700 disabled:text-slate-400 rounded px-4 py-2 font-medium transition-colors"
        >
          {isLoading ? "Starting..." : "Start crawl"}
        </button>

        <a href="/jobs" className="block text-center text-sm text-slate-400 hover:text-white">
          View job history →
        </a>
      </div>
    </div>
  );
}