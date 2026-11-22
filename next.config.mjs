/** @type {import('next').NextConfig} */
const nextConfig = {
  devIndicators: false,
  serverExternalPackages: ["node:sqlite"],
  webpack: (config, { isServer }) => {
    if (isServer) {
      const existing = config.externals || [];
      config.externals = [
        ...(Array.isArray(existing) ? existing : [existing]),
        ({ request }, callback) => {
          if (request === "node:sqlite") {
            return callback(null, "commonjs node:sqlite");
          }
          callback();
        },
      ];
    }
    return config;
  },
};

export default nextConfig;
