import { z } from "zod";

export const ColorSchema = z.enum(["red", "blue"]);

export const LevelSchema = z.enum(["Low", "Medium", "High"]);

export const CodeSchema = z.enum([1, 2]);

export const CatSchema = z.object({
	kind: z.literal("cat"),
	lives: z.number()
});

export const DogSchema = z.object({
	bark: z.boolean()
});

export const SelfRefSchema = z.object({
	id: z.string(),
	parent: SelfRefSchema.optional()
});

export const AnimalSchema = z.object({
	kind: z.string()
});

export const DuckSchema = z.object({
	kind: z.literal("duck"),
	quacks: z.boolean()
});

export const SwanSchema = z.object({
	kind: z.literal("swan")
});

export const PrefSchema = z.object({
	level: LevelSchema
});

export const NoticeBaseSchema = z.object({
	channel: z.string(),
	id: z.string()
});

export const GoogleNoticeSchema = z.object({
	channel: z.literal("google"),
	id: z.string(),
	retryCount: z.number()
});

export const YandexNoticeSchema = z.object({
	channel: z.literal("yandex"),
	id: z.string(),
	retryCount: z.number()
});

export const Cat2Schema = z.object({
	kind: z.literal("cat"),
	lives: z.number()
});

export const Dog2Schema = z.object({
	kind: z.literal("dog"),
	bark: z.boolean()
});

export const CodedSchema = z.object({
	code: CodeSchema
});
