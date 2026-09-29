const { CHINA_EDITION } = require('./scripts/release/edition')

module.exports = async function createChinaEditionConfig() {
  return {
    extends: './electron-builder.yml',
    appId: 'com.cherryai.cherrystudio.cn',
    extraMetadata: {
      cherryEdition: CHINA_EDITION
    }
  }
}
