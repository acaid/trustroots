'use strict';

/**
 * Module dependencies.
 */
var _ = require('lodash'),
    errorHandler = require('../errors'),
    mongoose = require('mongoose'),
    passport = require('passport'),
    User = mongoose.model('User'),
    config = require('../../../config/config'),
    nodemailer = require('nodemailer'),
    async = require('async'),
    crypto = require('crypto');

/**
 * Signup
 */
exports.signup = function(req, res) {
  async.waterfall([

    // Generate random token
    function(done) {
      crypto.randomBytes(20, function(err, buffer) {
        var token = buffer.toString('hex');
        done(err, token);
      });
    },

    // Save user
    function(token, done) {

      // For security measurement we remove the roles from the req.body object
      delete req.body.roles;

      // Init Variables
      var user = new User(req.body);
      var message = null;

      // Add missing user fields
      user.emailToken = token;
      user.public = false;
      user.provider = 'local';
      user.displayName = user.firstName + ' ' + user.lastName;

      // Just to simplify email confirm process later
      // This field is needed when changing email after the signup process
      user.emailTemporary = user.email;

      // Then save the user
      user.save(function(err) {
        if (!err) {
          // Remove sensitive data before login
          user.password = undefined;
          user.salt = undefined;
        }

        done(err, user);

      });

    },

    // Prepare HTML email
    function(user, done) {

      var url = (config.https ? 'https' : 'http') + '://' + req.headers.host;
      var renderVars = {
        name: user.displayName,
        email: user.email,
        ourMail: config.mailer.from,
        url: url,
        urlConfirm: url + '/#!/confirm-email/' + user.emailToken + '?signup',
      };

      res.render('email-templates/signup', renderVars, function(err, emailHTML) {
        done(err, emailHTML, user, renderVars, url);
      });
    },

    // Prepare TEXT email
    function(emailHTML, user, renderVars, url, done) {
      res.render('email-templates-text/signup', renderVars, function(err, emailPlain) {
        done(err, emailHTML, emailPlain, user, url);
      });
    },

    // If valid email, send confirm email using service
    function(emailHTML, emailPlain, user, url, done) {
      var smtpTransport = nodemailer.createTransport(config.mailer.options);
      var mailOptions = {
        to: user.displayName + ' <' + user.email + '>',
        from: 'Trustroots <' + config.mailer.from + '>',
        subject: 'Confirm Email',
        html: emailHTML,
        text: emailPlain,
        // Attaching vCard makes it more certain this mail to pass spamfilters and users can add us to their trusted mails list easier.
        attachments: [{
          filename: 'trustroots.vcf',
          content: 'BEGIN:VCARD\r\nN:Trustroots;Trustroots;;;\r\nEMAIL;INTERNET:' + config.mailer.from + '\r\nORG:Trustroots\r\nURL:' + url + '\r\nEND:VCARD',
          contentType: 'text/vcard'
        }]
      };
      smtpTransport.sendMail(mailOptions, function(err) {
        smtpTransport.close(); // close the connection pool
        done(err, user);
      });
    },

    // Login
    function(user, done) {
      req.login(user, function(err) {
        if (!err) {
          delete user.emailToken;
          res.json(user);
        }
        done(err);
      });
    }

  ], function(err) {
    if (err) {
      return res.status(400).send({
        message: errorHandler.getErrorMessage(err)
      });
    }
  });
};


/**
 * Signin after passport authentication
 */
exports.signin = function(req, res, next) {
  passport.authenticate('local', function(err, user, info) {
    if (err || !user) {
      res.status(400).send(info);
    } else {
      // Remove sensitive data before login
      user.password = undefined;
      user.salt = undefined;

      req.login(user, function(err) {
        if (err) {
          res.status(400).send(err);
        } else {
          res.json(user);
        }
      });
    }
  })(req, res, next);
};

/**
 * Signout
 */
exports.signout = function(req, res) {
  req.logout();
  res.redirect('/');
};

/**
 * OAuth callback
 */
exports.oauthCallback = function(strategy) {
  return function(req, res, next) {
    passport.authenticate(strategy, function(err, user, redirectURL) {
      if (err || !user) {
        return res.redirect('/#!/signin');
      }
      req.login(user, function(err) {
        if (err) {
          return res.redirect('/#!/signin');
        }

        return res.redirect(redirectURL || '/');
      });
    })(req, res, next);
  };
};

/**
 * Helper function to save or update a OAuth user profile
 */
exports.saveOAuthUserProfile = function(req, providerUserProfile, done) {
  if (!req.user) {
    // Define a search query fields
    var searchMainProviderIdentifierField = 'providerData.' + providerUserProfile.providerIdentifierField;
    var searchAdditionalProviderIdentifierField = 'additionalProvidersData.' + providerUserProfile.provider + '.' + providerUserProfile.providerIdentifierField;

    // Define main provider search query
    var mainProviderSearchQuery = {};
    mainProviderSearchQuery.provider = providerUserProfile.provider;
    mainProviderSearchQuery[searchMainProviderIdentifierField] = providerUserProfile.providerData[providerUserProfile.providerIdentifierField];

    // Define additional provider search query
    var additionalProviderSearchQuery = {};
    additionalProviderSearchQuery[searchAdditionalProviderIdentifierField] = providerUserProfile.providerData[providerUserProfile.providerIdentifierField];

    // Define a search query to find existing user with current provider profile
    var searchQuery = {
      $or: [mainProviderSearchQuery, additionalProviderSearchQuery]
    };

    User.findOne(searchQuery, function(err, user) {
      if (err) {
        return done(err);
      } else {
        if (!user) {
          var possibleUsername = providerUserProfile.username || ((providerUserProfile.email) ? providerUserProfile.email.split('@')[0] : '');

          User.findUniqueUsername(possibleUsername, null, function(availableUsername) {
            user = new User({
              firstName: providerUserProfile.firstName,
              lastName: providerUserProfile.lastName,
              username: availableUsername,
              displayName: providerUserProfile.displayName,
              email: providerUserProfile.email,
              provider: providerUserProfile.provider,
              providerData: providerUserProfile.providerData
            });

            // And save the user
            user.save(function(err) {
              return done(err, user);
            });
          });
        } else {
          return done(err, user);
        }
      }
    });
  } else {
    // User is already logged in, join the provider data to the existing user
    var user = req.user;

    // Check if user exists, is not signed in using this provider, and doesn't have that provider data already configured
    if (user.provider !== providerUserProfile.provider && (!user.additionalProvidersData || !user.additionalProvidersData[providerUserProfile.provider])) {
      // Add the provider data to the additional provider data field
      if (!user.additionalProvidersData) user.additionalProvidersData = {};
      user.additionalProvidersData[providerUserProfile.provider] = providerUserProfile.providerData;

      // Then tell mongoose that we've updated the additionalProvidersData field
      user.markModified('additionalProvidersData');

      // And save the user
      user.save(function(err) {
        return done(err, user, '/#!/settings/accounts');
      });
    } else {
      return done(new Error('User is already connected using this provider'), user);
    }
  }
};

/**
 * Remove OAuth provider
 */
exports.removeOAuthProvider = function(req, res, next) {
  var user = req.user;
  var provider = req.param('provider');

  if (user && provider) {
    // Delete the additional provider
    if (user.additionalProvidersData[provider]) {
      delete user.additionalProvidersData[provider];

      // Then tell mongoose that we've updated the additionalProvidersData field
      user.markModified('additionalProvidersData');
    }

    user.save(function(err) {
      if (err) {
        return res.status(400).send({
          message: errorHandler.getErrorMessage(err)
        });
      } else {
        req.login(user, function(err) {
          if (err) {
            res.status(400).send(err);
          } else {
            res.json(user);
          }
        });
      }
    });
  }
};


/**
 * Confirm email GET from email token
 */
exports.validateEmailToken = function(req, res) {
  User.findOne({
    emailToken: req.params.token
  }, function(err, user) {
    if (!user) {
      return res.redirect('/#!/confirm-email-invalid');
    }

    res.redirect('/#!/confirm-email/' + req.params.token);
  });
};

/**
 * Confirm email POST from email token
 */
exports.confirmEmail = function(req, res, next) {

  async.waterfall([

    function(done) {

      // Check if user exists with this token
      User.findOne({
        emailToken: req.params.token
      }, function(err, user) {
        if (!err && user) {

          // Will be the returned object when no errors
          var result = {};

          // If users profile was hidden, it means it was first confirmation email after registration.
          result.profileMadePublic = !user.public;

          // We can't do this here because we've got user document with password and we'd just override it:
          //user.save(function(err) {
          // Instead we'll do normal mongoose update with previously fetched user id
          User.findByIdAndUpdate(
            user._id,
            {
              $unset: {
                emailTemporary: 1,
                emailToken: 1
              },
              $set: {
                public: true,
                // Replace old email with new one
                email: user.emailTemporary,
                emailHash: crypto.createHash('md5').update( user.emailTemporary.trim().toLowerCase() ).digest('hex')
              }
            },
            function (err, user) {
              if (err) {
                return res.status(400).send({
                  message: errorHandler.getErrorMessage(err)
                });
              } else {
                req.login(user, function(err) {
                  if (!err) {
                    // Return authenticated user
                    result.user = user;
                    res.json(result);
                  }
                  done(err);
                });
              }
            });

        } else {
          return res.status(400).send({
            message: 'Email confirm token is invalid or has expired.'
          });
        }
      });
    }
  ], function(err) {
    if (err) {
      return res.status(400).send({
        message: errorHandler.getErrorMessage(err)
      });
    }
  });
};
