// Jest (unlike Metro) does not auto-apply babel-preset-expo, so the jest-expo preset
// needs this explicit Babel config to transform Expo/React Native source in tests.
module.exports = function (api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
  };
};
