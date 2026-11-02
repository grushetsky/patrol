import "@typespec/http";
import "@typespec/openapi";
import "@typespec/openapi3";
import "@typespec/json-schema";

using TypeSpec.Http;
using TypeSpec.JsonSchema;
using TypeSpec.OpenAPI;

@service(#{ title: "Gaps" })
@jsonSchema("https://patrol.example/gaps/")
namespace Gaps;

scalar UserId extends string;

enum Color { Red: "red", Blue: "blue" }

model Cat { kind: "cat"; lives: int32 = 9; }
model Dog { bark: boolean; }

// plain union (no decorators)
union Pet { cat: Cat, dog: Dog }

// envelope none discriminated union
@discriminated(#{ discriminatorPropertyName: "kind", envelope: "none" })
union PetFlat { cat: Cat, dog: Dog }

// envelope object (default)
@discriminated(#{ discriminatorPropertyName: "kind" })
union PetEnvelope { cat: Cat, dog: Dog }

model SelfRef { id: UserId; parent?: SelfRef; }

// numeric enum (implicit values)
enum Level { Low, Medium, High }

// literal-only named union
union Channel { google: "google", bing: "bing" }

// model-based polymorphism via @discriminator
@discriminator("kind")
model Animal { kind: string; }
model Duck extends Animal { kind: "duck"; quacks: boolean; }
model Swan extends Animal { kind: "swan"; }

model Pref { level: Level = Level.Low; }

// Workaround candidate: model inheritance + @discriminator with literal values.
@discriminator("channel")
model NoticeBase { channel: string; id: string; }
model GoogleNotice extends NoticeBase { channel: "google"; retryCount: int32 = 0; }
model YandexNotice extends NoticeBase { channel: "yandex"; retryCount: int32 = 0; }

// Recommended shape: plain union of models that carry their own literal
// discriminator property (no @discriminated/@discriminator decorators).
model Cat2 { kind: "cat"; lives: int32; }
model Dog2 { kind: "dog"; bark: boolean; }
union Pet2 { cat: Cat2, dog: Dog2 }

enum Code { One: 1, Two: 2 }
model Coded { code: Code = Code.One; }
