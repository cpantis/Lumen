/**
 * Message decoding from MCAP schemas.
 *
 * Nothing is hard-coded: decoders are built from the schema stored in the file
 * (`ros2msg` or `ros2idl` encoding, CDR message encoding). JSON-encoded channels
 * are supported too. Unknown encodings yield a decoder that throws a descriptive
 * error, which callers turn into an "unable to decode" state instead of crashing.
 */
import { parse as parseRosMsg } from "@foxglove/rosmsg";
import { parseRos2idl } from "@foxglove/ros2idl-parser";
import { MessageReader } from "@foxglove/rosmsg2-serialization";
import type { MessageDefinition } from "@foxglove/message-definition";
import { decompress as zstdDecompress } from "fzstd";
// lz4js has no types; it exposes decompress(src, maxSize?) → number[] | Uint8Array.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import * as lz4 from "lz4js";

export interface SchemaInfo {
  id: number;
  name: string;
  encoding: string;
  data: Uint8Array;
}

export interface ChannelInfo {
  id: number;
  topic: string;
  messageEncoding: string;
  schemaId: number;
  metadata?: Map<string, string>;
}

export type Decoder = (data: Uint8Array) => unknown;

const textDecoder = new TextDecoder();

/** Parses schema text into message definitions (first = root type). */
export function parseSchemaDefinitions(schema: SchemaInfo): MessageDefinition[] {
  const text = textDecoder.decode(schema.data);
  if (schema.encoding === "ros2msg") return parseRosMsg(text, { ros2: true });
  if (schema.encoding === "ros2idl") return parseRos2idl(text);
  throw new Error(`Schema encoding nesuportat: "${schema.encoding}"`);
}

/** Builds a decoder for a channel. Never throws: errors surface at decode time. */
export function makeDecoder(channel: ChannelInfo, schema: SchemaInfo | undefined): Decoder {
  try {
    if (channel.messageEncoding === "cdr") {
      if (!schema) throw new Error("Schema lipsă pentru canal CDR");
      const defs = parseSchemaDefinitions(schema);
      const reader = new MessageReader(defs);
      return (data) => reader.readMessage(data);
    }
    if (channel.messageEncoding === "json") {
      return (data) => JSON.parse(textDecoder.decode(data));
    }
    throw new Error(`Message encoding nesuportat: "${channel.messageEncoding}"`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return () => {
      throw new Error(msg);
    };
  }
}

/**
 * Returns the definition of the root message (useful for the generic panel: field
 * paths, types) or undefined when the schema cannot be parsed.
 */
export function rootDefinition(schema: SchemaInfo | undefined): MessageDefinition | undefined {
  if (!schema) return undefined;
  try {
    return parseSchemaDefinitions(schema)[0];
  } catch {
    return undefined;
  }
}

/** True when the root type starts with a std_msgs/Header field named "header". */
export function hasHeader(schema: SchemaInfo | undefined): boolean {
  const root = rootDefinition(schema);
  const f = root?.definitions.find((d) => !d.isConstant);
  return !!f && f.name === "header" && /Header$/.test(f.type);
}

/** Decompression handlers for MCAP chunks (pure JS → identical in browser and Node). */
export const decompressHandlers = {
  zstd: (buf: Uint8Array, size: bigint) => {
    const out = new Uint8Array(Number(size));
    zstdDecompress(buf, out);
    return out;
  },
  lz4: (buf: Uint8Array, size: bigint) => {
    const out = (lz4 as { decompress: (b: Uint8Array, n?: number) => ArrayLike<number> }).decompress(buf, Number(size));
    return out instanceof Uint8Array ? out : Uint8Array.from(out);
  },
};

/** Normalises a schema name: "sensor_msgs/msg/Image" → "sensor_msgs/Image". */
export function shortType(name: string): string {
  return name.replace("/msg/", "/");
}
