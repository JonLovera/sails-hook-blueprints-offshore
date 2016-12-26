/**
 * Module dependencies
 */

var _ = require('@sailshq/lodash');
var isString = require('lodash.isstring');
var isArray = require('lodash.isarray');
var isObject = require('lodash.isobject');
var isUndefined = require('lodash.isundefined');
var actionUtil = require('sails/lib/hooks/blueprints/actionUtil');

// Parameter used for jsonp callback is constant, as far as
// blueprints are concerned (for now.)
var JSONP_CALLBACK_PARAM = 'callback';

/**
* Given a Waterline query, populate the appropriate/specified
* association attributes and return it so it can be chained
* further ( i.e. so you can .exec() it )
*
* @param  {Query} query         [waterline query object]
* @param  {Array} associations  [array of objects with an alias
*                                and (optional) limit key]
* @return {Query}
*/
actionUtil.populateQuery = function(query, associations, sails) {
    var DEFAULT_POPULATE_LIMIT = (sails && sails.config.blueprints.defaultLimit) || 30;

    return _.reduce(associations, function(query, association) {
        let alias = association.alias;
        association.limit = association.limit || DEFAULT_POPULATE_LIMIT;
        delete association.alias;
      return query.populate(alias, association);
    }, query);
};

/**
* Given a Waterline query and an express request, populate
* the appropriate/specified association attributes and
* return it so it can be chained further ( i.e. so you can
* .exec() it )
*
* @param  {Query} query         [waterline query object]
* @param  {Request} req
* @return {Query}
*/
actionUtil.populateRequest = function(query, req) {
    var DEFAULT_POPULATE_LIMIT = req._sails.config.blueprints.defaultLimit || 30;
    var _options = req.options;
    var aliasFilter = req.param('populate');
    var shouldPopulate = _options.populate;

    // Convert the string representation of the filter list to an Array. We
    // need this to provide flexibility in the request param. This way both
    // list string representations are supported:
    //   /model?populate=alias1,alias2,alias3
    //   /model?populate=[alias1,alias2,alias3]
    if (typeof aliasFilter === 'string') {
      aliasFilter = aliasFilter.replace(/\[|\]/g, '');
      aliasFilter = (aliasFilter) ? aliasFilter.split(',') : [];
    }

    var associations = [];

    _.each(_options.associations, function(association) {
      _.forEach(aliasFilter, function(val) {
        shouldPopulate = val.match(new RegExp(association.alias)) ? true : false;
        // If we know that we should populate, we must break the loop
        if (shouldPopulate) {
          // If we can validate the population, set the right (deep) alias
          association.alias = val;
          return false;
        }
      });

      // Only populate associations if a population filter has been supplied
      // with the request or if `populate` is set within the blueprint config.
      // Population filters will override any value stored in the config.
      //
      // Additionally, allow an object to be specified, where the key is the
      // name of the association attribute, and value is true/false
      // (true to populate, false to not)
      if (shouldPopulate) {
          let realAlias = association.alias.split('.')[0];

            // IMPORTANT NOTE: This is my trick. We should take advanced options from request parameter to make requests even more flexible
            var populationOptions = req.param('populate_' + realAlias);
            populationOptions = tryToParseJSON(populationOptions);

            if (!populationOptions)
                populationOptions = {
                  alias: association.alias,
                  limit: populationLimit
                };

            if (!populationOptions.alias)
                populationOptions.alias = association.alias;


            if (!populationOptions.limit) {
                var populationLimit = _options['populate_' + realAlias +'_limit'] ||
                                      _options.populate_limit ||
                                      _options.limit ||
                                      DEFAULT_POPULATE_LIMIT;
                populationOptions.limit= populationLimit;
            }

            associations.push(populationOptions);
      }
    });

    return actionUtil.populateQuery(query, associations, req._sails);
};

/**
* Subscribe deep (associations)
*
* @param  {[type]} associations [description]
* @param  {[type]} record       [description]
* @return {[type]}              [description]
*/
actionUtil.subscribeDeep = function ( req, record ) {
    _.each(req.options.associations, function (assoc) {

      // Look up identity of associated model
      var ident = assoc[assoc.type];
      var AssociatedModel = req._sails.models[ident];

      if (req.options.autoWatch) {
        AssociatedModel.watch(req);
      }

      // Subscribe to each associated model instance in a collection
      if (assoc.type === 'collection') {
        _.each(record[assoc.alias], function (associatedInstance) {
          AssociatedModel.subscribe(req, [associatedInstance[AssociatedModel.primaryKey]]);
        });
      }
      // If there is an associated to-one model instance, subscribe to it
      else if (assoc.type === 'model' && record[assoc.alias]) {
        AssociatedModel.subscribe(req, [record[assoc.alias][AssociatedModel.primaryKey]]);
      }
    });
};


  /**
   * Parse `criteria` for a Waterline `find` or `update` from all
   * request parameters.
   *
   * @param  {Request} req
   *
   * @returns {Dictionary}
   *          The normalized WHERE clause
   *
   * @throws {Error} If WHERE clause cannot be parsed.
   *         @property {String} `code: 'E_WHERE_CLAUSE_UNPARSEABLE'`
   */
  actionUtil.parseCriteria= function ( req ) {

    // Allow customizable blacklist for params NOT to include as criteria.
    req.options.criteria = req.options.criteria || {};
    req.options.criteria.blacklist = req.options.criteria.blacklist || ['limit', 'skip', 'sort', 'populate'];
    req.options.criteria.blacklist = req.options.criteria.blacklist || ['limit', 'skip', 'sort', 'populate'];

    _.each(req.options.associations, function(association) {
        let realAlias = association.alias.split('.')[0];

        // IMPORTANT NOTE: This is my trick. We should take advanced options from request parameter to make requests even more flexible
        req.options.criteria.blacklist.push('populate_' + realAlias);
    });

    // Validate blacklist to provide a more helpful error msg.
    var blacklist = req.options.criteria && req.options.criteria.blacklist;
    if (blacklist && !isArray(blacklist)) {
      throw new Error('Invalid `req.options.criteria.blacklist`. Should be an array of strings (parameter names.)');
    }

    // Look for explicitly specified `where` parameter.
    var where = req.params.all().where;

    // If `where` parameter is a string, try to interpret it as JSON
    if (isString(where)) {
      where = tryToParseJSON(where);
    }

    // If `where` has not been specified, but other unbound parameter variables
    // **ARE** specified, build the `where` option using them.
    if (!where) {

      // Prune params which aren't fit to be used as `where` criteria
      // to build a proper where query
      where = req.params.all();

      // Omit built-in runtime config (like query modifiers)
      where = _.omit(where, blacklist || ['limit', 'skip', 'sort']);

      // Omit any params w/ undefined values
      where = _.omit(where, function(p) {
        if (isUndefined(p)) {return true;}
      });

      // Omit jsonp callback param (but only if jsonp is enabled)
      var jsonpOpts = req.options.jsonp && !req.isSocket;
      jsonpOpts = isObject(jsonpOpts) ? jsonpOpts : { callback: JSONP_CALLBACK_PARAM };
      if (jsonpOpts) {
        where = _.omit(where, [jsonpOpts.callback]);
      }
    }

    // Merge w/ req.options.where.
    where = _.merge({}, req.options.where || {}, where) || undefined;

    // Check `WHERE` clause for unsupported usage.
    // (throws if bad structure is detected)
    // validateWhereClauseStrict(where);

    // Return final `where`.
    return where;
};

// TODO:
//
// Replace the following helper with the version in sails.util:

// Attempt to parse JSON
// If the parse fails, return the error object
// If JSON is falsey, return null
// (this is so that it will be ignored if not specified)
function tryToParseJSON (json) {
  if (!_.isString(json)) { return null; }
  try {
    return JSON.parse(json);
  }
  catch (e) { return e; }
}

module.exports = actionUtil;
