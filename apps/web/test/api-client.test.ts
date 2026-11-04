import { describe, expect, it } from "vitest";
import {
  ApiError,
  errorMessage,
  fieldErrorFromBody,
  messageFromBody,
} from "../src/api/client";

describe("API error rendering", () => {
  it("prefers the first field error over the top-level message", () => {
    const body = {
      code: "validation_failed",
      message: "The request body is invalid.",
      fieldErrors: [
        { path: "/email", message: "Enter a valid email address." },
      ],
    };
    expect(fieldErrorFromBody(body)).toBe("Enter a valid email address.");
    expect(errorMessage(new ApiError(400, body), "fallback")).toBe(
      "Enter a valid email address.",
    );
  });

  it("falls back to the message and then the caller's text", () => {
    expect(messageFromBody({ message: "No valid session." })).toBe(
      "No valid session.",
    );
    expect(errorMessage(new ApiError(401, {}), "fallback")).toBe("fallback");
    expect(errorMessage(new Error("network"), "fallback")).toBe("fallback");
  });
});
