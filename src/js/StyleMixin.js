/** @jsx React.DOM */

var ClientID = require('./ClientID');
var _ = require('lodash');
var styleRuleConverter = require('./rcss/styleRuleConverter');

var lastMixinID = 1;

function StyleMixin(stylesByName) {
  var mixinID = lastMixinID++;
  var classesByStyleName;
  var hasInjectedStyles = false;

  return {
    componentWillMount() {
      if (hasInjectedStyles) {
        this.styles = classesByStyleName;
        return;
      }

      var processedStylesByName = _.mapValues(stylesByName, processStyle);
      var classNameBase = this.constructor.displayName + '-' + mixinID;
      var cssRules = [];
      classesByStyleName = _.mapValues(processedStylesByName, (style, name) => {
        var className = classNameBase + '_' + name;
        var css = styleRuleConverter.rulesToString(className, style);
        cssRules.push(css);
        return className;
      });
      this.styles = classesByStyleName;

      var tag = document.createElement('style');
      tag.innerHTML = cssRules.join('\n');
      document.getElementsByTagName('head')[0].appendChild(tag);

      hasInjectedStyles = true;
    },
  };
}

function processStyle(style) {
  if (Array.isArray(style)) {
    var processedStyles = style.map(processStyle);
    return Object.assign.apply(null, [{}].concat(processedStyles));
  }

  return _.mapValues(style, (value, key) => {
    if (value instanceof Color) {
      return value.toString();
    }

    // nested, like :hover or :after
    if (_.isObject(value)) {
      return processStyle(value);
    }

    return value;
  });
}

module.exports = StyleMixin;