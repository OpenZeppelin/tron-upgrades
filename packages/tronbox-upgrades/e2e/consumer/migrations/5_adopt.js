const { forceImport } = require('@openzeppelin/tronbox-upgrades');
const fs = require('fs');
const path = require('path');

const Box = artifacts.require('Box');
const BoxV2 = artifacts.require('BoxV2');

module.exports = async function (deployer) {
  const handles = { deployer, artifacts, tronWrap, waitForTransactionReceipt };
  const proxy = Box.address;

  // Set the record aside so adoption starts from nothing, then restore it:
  // the run must stay repeatable, and the adoption's own record is asserted
  // before the original comes back.
  const recordDir = path.resolve('.openzeppelin');
  const saved = fs.readdirSync(recordDir).map(name => ({
    name,
    text: fs.readFileSync(path.join(recordDir, name), 'utf8'),
  }));
  for (const file of saved) fs.unlinkSync(path.join(recordDir, file.name));

  try {
    const adopted = await forceImport(proxy, BoxV2, handles);
    console.log('E2E m5.kind=' + adopted.kind);
    console.log('E2E m5.address=' + adopted.address);

    const recreated = fs
      .readdirSync(recordDir)
      .filter(name => name.endsWith('.json') && !name.endsWith('.instance.json'));
    if (recreated.length === 0) {
      throw new Error('e2e: adoption wrote no record');
    }
    const text = fs.readFileSync(path.join(recordDir, recreated[0]), 'utf8');
    const bare = proxy.replace(/^(0x|41)/i, '').toLowerCase();
    if (!text.toLowerCase().includes(bare)) {
      throw new Error('e2e: the adopted record does not name the proxy');
    }
  } finally {
    for (const file of saved) {
      fs.writeFileSync(path.join(recordDir, file.name), file.text);
    }
  }
};
