import { queryOptions } from "@tanstack/react-query";
import { t, TEST_LOCALE } from "@patrol/i18n";
import { ApiError, api } from "./client";

/**
 * Query options own the fetch; the route loader only decides when to await
 * it. The health report's type comes from the generated OpenAPI document, so
 * a change to the TypeSpec model breaks this file at compile time.
 */
export const healthQuery = queryOptions({
  queryKey: ["system", "health"],
  queryFn: async () => {
    const { data, response } = await api.GET("/health");
    if (!response.ok || !data) {
      // The thrown error keeps the status and the ErrorBody's stable `code`
      // for callers that branch on them; `code` is never localized, this
      // display message is.
      const errorBody = data as { code?: string } | undefined;
      throw new ApiError(
        t(TEST_LOCALE, "errors.internal_error"),
        response.status,
        errorBody?.code,
      );
    }
    return data;
  },
});
