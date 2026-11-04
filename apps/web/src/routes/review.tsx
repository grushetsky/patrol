import { createFileRoute } from "@tanstack/react-router";
import { NextSlice } from "../components/placeholder";

export const Route = createFileRoute("/review")({
  component: () => <NextSlice section="review" />,
});
