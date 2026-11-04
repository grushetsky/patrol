import { queryOptions } from "@tanstack/react-query";
import { api } from "./client";

export const versionQuery = queryOptions({
  queryKey: ["system", "version"],
  queryFn: async () => {
    const { data, error, response } = await api.GET("/system/version");
    if (error) {
      throw new Error(`GET /system/version failed: ${response.status}`);
    }
    return data;
  },
});
