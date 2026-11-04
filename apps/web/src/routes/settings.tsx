import { createFileRoute } from "@tanstack/react-router";
import { NextSlice } from "../components/placeholder";

export const Route = createFileRoute("/settings")({
  component: () => <NextSlice section="settings" />,
});
