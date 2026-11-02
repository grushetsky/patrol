import { z } from "zod";

export const CaseStatusSchema = z.enum(["open", "triage", "notice_sent", "closed"]);

export const DetectionConfidenceSchema = z.enum(["low", "medium", "high"]);

export const EvidenceSchema = z.object({
	id: z.string(),
	kind: z.union([z.literal("screenshot"), z.literal("html"), z.literal("video")]),
	capturedAt: z.string().datetime(),
	sha256: z.string(),
	derivedFrom: EvidenceSchema.optional()
});

export const ViolationSchema = z.object({
	id: z.string().uuid(),
	titleId: z.string(),
	status: CaseStatusSchema,
	confidence: DetectionConfidenceSchema,
	detectedAt: z.string().datetime(),
	sourceUrl: z.string().url(),
	evidence: z.array(EvidenceSchema),
	note: z.union([z.string(), z.null()]).optional()
});

export const NotFoundSchema = z.object({
	_: z.literal(404),
	message: z.string()
});

export const DmcaNoticeSchema = z.object({
	channel: z.literal("google"),
	id: z.string().uuid(),
	violationId: z.string().uuid(),
	submittedAt: z.string().datetime().optional(),
	retryCount: z.number()
});

export const InfringementNoticeSchema = z.object({
	channel: z.literal("yandex"),
	id: z.string().uuid(),
	violationId: z.string().uuid(),
	submittedAt: z.string().datetime().optional(),
	retryCount: z.number()
});

export const CreateNoticeRequestSchema = z.object({
	violationId: z.string().uuid(),
	channel: z.union([z.literal("google"), z.literal("yandex")])
});
