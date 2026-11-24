/**
 * Message decoding from MCAP schemas (all encodings with a public spec in the MCAP
 * registry, https://mcap.dev/spec/registry):
 *
 *   message_encoding  schema encoding      decoder
 *   cdr               ros2msg / ros2idl    @foxglove/rosmsg2-serialization
 *   cdr               omgidl               @foxglove/omgidl-serialization
 *   ros1              ros1msg              @foxglove/rosmsg-serialization
 *   protobuf          protobuf (FileDescriptorSet)  protobufjs
 *   json              jsonschema / ""      JSON.parse
 *   cbor / msgpack    "" (self-describing) cbor-x / @msgpack/msgpack
 *   flatbuffer, capnproto                  not supported → explicit "unable to decode"
 *
 * Nothing is hard-coded: decoders are built from the schema stored in the file. Every
 * decoded message goes through `normalizeMessage` (ROS 1 / Foxglove → canonical shape).
 * Unknown encodings yield a decoder that throws a descriptive error, which callers turn
 * into an "unable to decode" state instead of crashing.
 */
import { parse as parseRosMsg } from "@foxglove/rosmsg";
import { parseRos2idl } from "@foxglove/ros2idl-parser";
import { MessageReader } from "@foxglove/rosmsg2-serialization";
import { MessageReader as Ros1Reader } from "@foxglove/rosmsg-serialization";
import { parseIDL } from "@foxglove/omgidl-parser";
import { MessageReader as OmgReader } from "@foxglove/omgidl-serialization";
import type { MessageDefinition } from "@foxglove/message-definition";
import protobuf from "protobufjs";
import descriptor from "protobufjs/ext/descriptor/index.js";
import { decode as cborDecode } from "cbor-x";
import { decode as msgpackDecode } from "@msgpack/msgpack";
import { decompress as zstdDecompress } from "fzstd";
// lz4js has no types; it exposes decompress(src, maxSize?) → number[] | Uint8Array.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import * as lz4 from "lz4js";
import { canonicalType, normalizeMessage } from "./normalize";

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

const sameType = (a: string | undefined, b: string) => !!a && a.replace(/::/g, "/").replace("/msg/", "/") === b.replace(/::/g, "/").replace("/msg/", "/");

/** Parses schema text into message definitions (first = root type). */
export function parseSchemaDefinitions(schema: SchemaInfo): MessageDefinition[] {
  const text = textDecoder.decode(schema.data);
  if (schema.encoding === "ros2msg") return parseRosMsg(text, { ros2: true });
  if (schema.encoding === "ros1msg") return parseRosMsg(text);
  if (schema.encoding === "ros2idl") {
    // ros2idl files may be concatenated in any order: the root is the type named by schema.name
    const defs = parseRos2idl(text);
    const i = defs.findIndex((d) => sameType(d.name, schema.name));
    if (i > 0) defs.unshift(...defs.splice(i, 1));
    return defs;
  }
  throw new Error(`Unsupported schema encoding for ROS definitions: "${schema.encoding}"`);
}

/** protobuf: Long → number, bytes stay Uint8Array, default values filled in. */
function protobufDecoder(schema: SchemaInfo): Decoder {
  const set = (descriptor as unknown as { FileDescriptorSet: { decode: (b: Uint8Array) => unknown } }).FileDescriptorSet.decode(schema.data);
  const root = (protobuf.Root as unknown as { fromDescriptor: (s: unknown) => protobuf.Root }).fromDescriptor(set);
  const type = root.lookupType(schema.name);
  return (data) => type.toObject(type.decode(data), { longs: Number, enums: Number, defaults: true, arrays: true });
}

function rawDecoder(channel: ChannelInfo, schema: SchemaInfo | undefined): Decoder {
  const enc = channel.messageEncoding;
  const need = () => {
    if (!schema) throw new Error(`Missing schema for ${enc} channel (schema_id 0)`);
    return schema;
  };
  switch (enc) {
    case "cdr": {
      const sc = need();
      if (sc.encoding === "omgidl") {
        const reader = new OmgReader(sc.name, parseIDL(textDecoder.decode(sc.data)));
        return (data) => reader.readMessage(data);
      }
      const reader = new MessageReader(parseSchemaDefinitions(sc));
      return (data) => reader.readMessage(data);
    }
    case "ros1": {
      const reader = new Ros1Reader(parseSchemaDefinitions(need()));
      return (data) => reader.readMessage(data);
    }
    case "protobuf":
      return protobufDecoder(need());
    case "json":
      return (data) => JSON.parse(textDecoder.decode(data));
    case "cbor":
      return (data) => cborDecode(data);
    case "msgpack":
      return (data) => msgpackDecode(data);
    case "flatbuffer":
    case "capnproto":
      throw new Error(`The "${enc}" encoding is not supported by StampTrace (it needs code generated from the schema); the topic appears in the inventory, but its messages cannot be decoded.`);
    default:
      throw new Error(`Unknown message encoding: "${enc}"`);
  }
}

/** Builds a decoder for a channel. Never throws: errors surface at decode time. */
export function makeDecoder(channel: ChannelInfo, schema: SchemaInfo | undefined): Decoder {
  try {
    const raw = rawDecoder(channel, schema);
    const name = schema?.name ?? "";
    return (data) => normalizeMessage(name, raw(data));
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

/**
 * Canonical type of a schema: "sensor_msgs/msg/Image" → "sensor_msgs/Image",
 * "sensor_msgs::msg::Image" → "sensor_msgs/Image", "foxglove.RawImage" → "sensor_msgs/Image".
 */
export function shortType(name: string): string {
  return canonicalType(name);
}
