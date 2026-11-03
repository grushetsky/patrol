namespace Patrol.Domain;

// Scalar value types shared by the domain. Scalars document and validate a
// shape; they are not nominal types in the generated TypeScript.

@doc("An absolute HTTP or HTTPS URL, stored verbatim unless a field says otherwise.")
@format("uri")
scalar Url extends string;

@doc("A URL reduced to the deduplication key: scheme dropped, host lowercased without a leading www, trailing slash trimmed, tracking parameters removed, remaining query parameters sorted, fragment dropped.")
scalar NormalizedUrl extends string;

@doc("A URL's host, or a violation's destination host after redirects. Lowercased DNS name, never a registrable-domain grouping.")
scalar Host extends string;

@doc("The eTLD+1 grouping of a host, used for reputation and reporting.")
scalar RegistrableDomain extends string;

@doc("An email address.")
@format("email")
scalar Email extends string;

@doc("A lowercase hexadecimal SHA-256 digest.")
@pattern("^[a-f0-9]{64}$")
scalar Sha256 extends string;

@doc("An ISO 3166-1 alpha-2 country code, uppercase.")
@pattern("^[A-Z]{2}$")
scalar CountryCode extends string;

@doc("An ISO 3166-1 alpha-2 territory code, uppercase, used where a rule applies to a country rather than a language.")
@pattern("^[A-Z]{2}$")
scalar Territory extends string;

@doc("A BCP 47 language tag with an optional territory, such as ru-RU.")
scalar Locale extends string;

@doc("An ISO 15924 script code, such as Latn or Cyrl.")
@pattern("^[A-Z][a-z]{3}$")
scalar ScriptCode extends string;

@doc("An IANA time zone identifier, such as Europe/Berlin.")
scalar TimeZoneId extends string;

@doc("A contact or legal postal address.")
model PostalAddress {
  @doc("The first address line.")
  line1: string;

  @doc("The second address line, when the address needs one.")
  line2?: string;

  @doc("The city or locality.")
  city: string;

  @doc("The state, province, or region, where the country uses one.")
  region?: string;

  @doc("The postal code.")
  postalCode: string;

  @doc("The country of the address.")
  country: CountryCode;
}

@doc("The browser and extraction settings of one capture, without which the capture cannot be explained or repeated.")
model CaptureProfile {
  @doc("The user agent Patrol identified itself with.")
  userAgent: string;

  @doc("The viewport width in CSS pixels.")
  @minValue(1)
  viewportWidth: int32;

  @doc("The viewport height in CSS pixels.")
  @minValue(1)
  viewportHeight: int32;

  @doc("The locale the browser was configured with.")
  locale: Locale;

  @doc("The browser's time zone.")
  timezone: TimeZoneId;

  @doc("Whether JavaScript ran before the DOM and screenshot were taken.")
  javascriptEnabled: boolean;

  @doc("Request kinds the capture blocked.")
  blockedResourceKinds: ResourceKind[];

  @doc("The navigation and readiness policy, such as a load plus settle rather than network idle.")
  navigationPolicy: string;

  @doc("The extractor version that produced the extraction sidecar.")
  extractorVersion: string;
}

@doc("One HTTP hop in a redirect chain.")
model RedirectHop {
  @doc("The URL of this hop.")
  url: Url;

  @doc("The status code this hop returned.")
  statusCode: int32;

  @doc("The Location header this hop returned, when it redirected.")
  location?: string;
}

@doc("An intent phrase an operator can edit, carrying the version a search result was issued under.")
model IntentPhrase {
  @doc("The phrase appended to the display title, in the locale's language.")
  text: string;

  @doc("The version of the phrase at issue time.")
  @minValue(1)
  version: int32;
}

@doc("An operator's attestation that a notice was filed as presented.")
model OperatorAttestation {
  @doc("When the operator attested.")
  attestedAt: utcDateTime;

  @doc("The version of the attestation statement the operator agreed to.")
  statementVersion: string;
}
