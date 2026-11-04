import { createFileRoute } from "@tanstack/react-router";
import { NextSlice } from "../components/placeholder";

export const Route = createFileRoute("/violations")({
  component: () => <NextSlice section="violations" />,
});
