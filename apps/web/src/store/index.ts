import { configureStore } from "@reduxjs/toolkit";
import { crawlerApi } from "./api";

export const store = configureStore({
  reducer: {
    [crawlerApi.reducerPath]: crawlerApi.reducer,
  },
  middleware: (getDefaultMiddleware) =>
    getDefaultMiddleware().concat(crawlerApi.middleware),
});

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;