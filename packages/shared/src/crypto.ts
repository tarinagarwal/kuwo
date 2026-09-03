import { createHash } from "node:crypto";
import {
  SignJWT,
  jwtVerify,
  generateKeyPair,
  exportJWK,
  importJWK,
  decodeProtectedHeader,
  type JWK,
} from "jose";
import {
  MandatePayloadSchema,
  OfferPayloadSchema,
  type MandatePayload,
  type OfferPayload,
} from "./schemas.js";

/** AP2 signs mandates with ES256 (ECDSA P-256); we follow the spec. */
export const ALG = "ES256";

/** Verifiable credential types, carried in the protected header (AP2-style `vct`). */
export const VCT = {
  mandate: "mandate.kuwo.open.1",
  offer: "offer.kuwo.1",
} as const;
export type Vct = (typeof VCT)[keyof typeof VCT];

export interface SigningKeypair {
  privateJwk: JWK;
  publicJwk: JWK;
}

export async function generateSigningKeypair(): Promise<SigningKeypair> {
  const { publicKey, privateKey } = await generateKeyPair(ALG, { extractable: true });
  return {
    privateJwk: await exportJWK(privateKey),
    publicJwk: await exportJWK(publicKey),
  };
}

export function sha256Base64Url(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("base64url");
}

/** Hash of a signed token, used to link records to the exact credential that authorized them. */
export const hashToken = sha256Base64Url;

/**
 * Absolute epoch-seconds expiry (number) or a jose duration string like "24h".
 */
export type ExpiresIn = number | string;

async function signToken(
  payload: Record<string, unknown>,
  privateJwk: JWK,
  vct: Vct,
  expiresIn: ExpiresIn,
): Promise<string> {
  const key = await importJWK(privateJwk, ALG);
  return new SignJWT(payload)
    .setProtectedHeader({ alg: ALG, typ: "kuwo+jwt", vct })
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(key);
}

/**
 * Verify signature, expiry, and credential type — in that order, all before
 * the payload is trusted with anything.
 */
async function verifyToken(token: string, publicJwk: JWK, expectedVct: Vct): Promise<Record<string, unknown>> {
  const header = decodeProtectedHeader(token);
  if (header["vct"] !== expectedVct) {
    throw new Error(`credential type mismatch: expected "${expectedVct}", got "${String(header["vct"])}"`);
  }
  const key = await importJWK(publicJwk, ALG);
  const { payload } = await jwtVerify(token, key, { algorithms: [ALG] });
  return payload as Record<string, unknown>;
}

export async function signMandate(
  payload: MandatePayload,
  userPrivateJwk: JWK,
  expiresIn: ExpiresIn,
): Promise<string> {
  return signToken(MandatePayloadSchema.parse(payload), userPrivateJwk, VCT.mandate, expiresIn);
}

export async function verifyMandate(token: string, userPublicJwk: JWK): Promise<MandatePayload> {
  return MandatePayloadSchema.parse(await verifyToken(token, userPublicJwk, VCT.mandate));
}

export async function signOffer(
  payload: OfferPayload,
  merchantPrivateJwk: JWK,
  expiresIn: ExpiresIn,
): Promise<string> {
  return signToken(OfferPayloadSchema.parse(payload), merchantPrivateJwk, VCT.offer, expiresIn);
}

export async function verifyOffer(token: string, merchantPublicJwk: JWK): Promise<OfferPayload> {
  return OfferPayloadSchema.parse(await verifyToken(token, merchantPublicJwk, VCT.offer));
}
