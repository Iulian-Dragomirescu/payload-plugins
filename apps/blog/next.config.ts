import type { NextConfig } from "next";

import { withPayload } from "@payloadcms/next/withPayload";

const config: NextConfig = {
  // Built from workspace source, not from a published artifact.
  transpilePackages: ["payload-adapter-prisma"],
  serverExternalPackages: ["@prisma/client", "@prisma/adapter-pg"],

  // The private ranges, so opening the LAN address `next dev` prints also
  // loads its dev assets.
  allowedDevOrigins: ["10.*.*.*", "172.*.*.*", "192.168.*.*", "*.local"],
};

export default withPayload(config, { devBundleServerPackages: false });
