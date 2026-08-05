// The harness's consumer config. The default key is the TRE quickstart's
// well-known development key — a local throwaway, never a real one.
module.exports = {
  networks: {
    development: {
      privateKey:
        process.env.E2E_PRIVATE_KEY ||
        'c8afe0306dbb962a4ce8c09954f050c57facf05eb7ac88497ee1489d741aaff1',
      userFeePercentage: 100,
      feeLimit: 1000 * 1e6,
      fullHost: process.env.E2E_FULL_HOST || 'http://127.0.0.1:9090',
      network_id: '9',
    },
  },
  compilers: { solc: { version: '0.8.26' } },
};
