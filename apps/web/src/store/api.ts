import { createApi, fetchBaseQuery } from "@reduxjs/toolkit/query/react";

// types matching the exact shapes from the backend
export interface Job {
  jobId: string;
  seedUrl: string;
  status: "running" | "completed" | "stopped" | "failed";
  pagesCrawled: number;
  queueSize?: number;
  startedAt: string;
  completedAt?: string | null;
  error?: string | null;
}

export interface JobListResponse {
  jobs: Job[];
}

export interface StartJobRequest {
  url: string;
  maxDepth: number;
  maxPages: number;
  crawlDelay: number;
}

export interface StartJobResponse {
  jobId: string;
  seedUrl: string;
  status: "running";
}

export interface StopJobResponse {
  jobId: string;
  message: string;
}

export const crawlerApi = createApi({
  reducerPath: "crawlerApi",
  baseQuery: fetchBaseQuery({
    baseUrl: process.env.NEXT_PUBLIC_API_BASE_URL,
  }),
  endpoints: (builder) => ({
    startJob: builder.mutation<StartJobResponse, StartJobRequest>({
      query: (body) => ({
        url: "/api/crawl/job",
        method: "POST",
        body,
      }),
    }),
    getJob: builder.query<Job, string>({
      query: (jobId) => `/api/crawl/job/${jobId}`,
    }),
    stopJob: builder.mutation<StopJobResponse, string>({
      query: (jobId) => ({
        url: `/api/crawl/job/${jobId}`,
        method: "DELETE",
      }),
    }),
    listJobs: builder.query<JobListResponse, void>({
      query: () => "/api/crawl/jobs",
    }),
  }),
});

export const {
  useStartJobMutation,
  useGetJobQuery,
  useStopJobMutation,
  useListJobsQuery,
} = crawlerApi;