/**
 * This file implements the code for assembling structured representations of
 * MIME headers into their final encoded forms. The code here is a companion to,
 * but completely independent of, mimeParserHeaders.js: the structured
 * representations that are used as input to functions in this file are exactly
 * the same form as would be produced by code in mimeParserHeaders.js.
 */

"use strict";

(function (global) {

/// Clamp a value in the range [min, max], defaulting to def if it is undefined.
function clamp(value, min, max, def) {
  if (value === undefined)
    return def;
  if (value < min)
    return min;
  if (value > max)
    return max;
  return value;
}

/**
 * An object that can assemble structured header representations into their MIME
 * representation.
 *
 * The parameter to the constructor is an object that allows for setting the
 * following options:
 *   maxLineLen: <integer between 30 and 900> [default=78]
 *     The number of logical characters to include in a line, not including the
 *     final CRLF combination.
 *   firstLineLen: <integer between 10 and maxLineLen> [default=maxLineLen]
 *     The number of logical characters to include in the first line of the
 *     header, to account for the header name taking up some space.
 *
 * The character-counting portion of this class operates using individual JS
 * characters as its representation of logical character, which is not the same
 * as the number of octets used as UTF-8. If non-ASCII characters are to be
 * included in headers without some form of encoding, then care should be taken
 * to set the maximum line length to account for the mismatch between character
 * counts and octet counts: the maximum line is 998 octets, which could be as
 * few as 332 JS characters (non-BMP characters, although they take up 4 octets
 * in UTF-8, count as 2 in JS strings).
 *
 * This code takes care to only insert line breaks at the higher-level breaking
 * points in a header (as recommended by RFC 5322), but it may need to resort to
 * including them more aggressively if this is not possible. If even aggressive
 * line-breaking cannot allow a header to be emitted without violating line
 * length restrictions, the methods will throw an exception to indicate this
 * situation.
 *
 * In general, this code does not attempt to modify its input; for example, it
 * does not attempt to change the case of any input characters, apply any
 * Unicode normalization algorithms, or convert email addresses to ACE where
 * applicable. The biggest exception to this rule is that most whitespace is
 * collapsed to a single space, even in unstructured headers, while most leading
 * and trailing whitespace is trimmed from inputs.
 */
function HeaderAssembler(options) {
  this._options = options;
  this._use2047 = options.use2047 === undefined ? false : options.use2047;
  /// The committed output of the header being written.
  this._output = "";
  /// The current line being built; note that we may insert a line break in the
  /// middle to keep under the maximum line length.
  this._currentLine = "";

  // The choice of minimum and maximum line length are not completely arbitrary.
  // The maximum line length permitted by RFC 5322 is 998 octets, not including
  // CRLF. 900 is chosen as the max length to give us some breathing room for
  // people making mistakes. The minimum line length is 30: note that, for the
  // RFC 2047 encoding to work properly, we have to be able to at least write
  // one character per line. A non-BMP character would take up 8 characters if
  // encoded via base64, so we need to include at least =?UTF-8?B?12345678?= on
  // each line. With a continuation space, that comes out to 20 characters; the
  // 30 is a round number that adds some breathing space for extra delimiters.
  // Using 78 for the maximum line length is recommended by RFC 5322.
  this._maxLineLen = clamp(options.maxLineLen, 30, 900, 78);

  /// The number of characters remaining before we need a line break.
  this._charsRemaining = clamp(options.firstLineLen, 10, 900, this._maxLineLen);
  /// The index of the last breakable position in the current line.
  this._lastSplitPoint = 0;
}

///////////////////////
// Low-level methods //
///////////////////////

/**
 * Reserve at least length characters in the current line. If there aren't
 * enough characters, insert a line break.
 *
 * @return Whether or not there is enough space for length characters.
 */
HeaderAssembler.prototype._reserveTokenSpace = function (length) {
  // Do we have enough characters left in the line? If not, break the line at
  // the last split point in the previous line.
  if (length > this._charsRemaining && this._lastSplitPoint > 0) {
    let preSplit = this._currentLine.slice(0, this._lastSplitPoint);
    let postSplit = this._currentLine.slice(this._lastSplitPoint).trimLeft();
    this._output += preSplit.trimRight() + '\r\n ';
    this._currentLine = postSplit;
    this._lastSplitPoint = 0;
    this._charsRemaining = this._maxLineLen - 1 - postSplit.length;
  }

  // If we still don't have enough characters, find the last whitespace
  // character and break there. We may be able to squeeze it in.
  if (length > this._charsRemaining) {
    let sp = this._currentLine.lastIndexOf(" ");
    if (sp == -1)
      return false;
    this._output += this._currentLine.slice(0, sp).trimRight() + '\r\n ';
    this._currentLine = this._currentLine.slice(sp + 1).trimLeft();
    this._charsRemaining = this._maxLineLen - 1 - this._currentLine.length;
    this._lastSplitPoint = 0;
  }
  // If there still isn't enough space, we can't break any more text.
  if (length > this._charsRemaining)
    return false;

  // We found the space!
  return true;
};

/**
 * Adds a block of text to the current header, inserting a break if necessary.
 * If mayBreakAfter is true and text does not end in whitespace, a single space
 * character may be added to the output.
 *
 * @param text          The text to add to the output.
 * @param mayBreakAfter If true, the current position in the output is a
 *                      candidate for inserting a line break.
 * @return              True if the text could not be added to the output
 *                      without violating maximum line length and false
 *                      otherwise.
 */
HeaderAssembler.prototype.addText = function (text, mayBreakAfter) {
  // Try to reserve space for the tokens. If we can't, give up.
  if (!this._reserveTokenSpace(text.length))
    return true;

  this._currentLine += text;
  this._charsRemaining -= text.length;
  if (mayBreakAfter) {
    // Make sure that there is an extra space if text could break afterwards.
    this._lastSplitPoint = this._currentLine.length;
    if (text[text.length - 1] != ' ') {
      this._currentLine += ' ';
      this._charsRemaining--;
    }
  }
  return false;
};

/**
 * Adds a block of text that may need quoting if it contains some character in
 * qchars. If it is already quoted, no quoting will be applied.
 *
 * @param text          The text to add to the output.
 * @param qchars        The set of characters that cannot appear outside of a
 *                      quoted string.
 * @param mayBreakAfter If true, the current position in the output is a
 *                      candidate for inserting a line break.
 * @return              True if the text could not be added to the output
 *                      without violating maximum line length and false
 *                      otherwise.
 */
HeaderAssembler.prototype.addQuotable = function (text, qchars, mayBreakAfter) {
  // Figure out if we need to quote the string. Don't quote a string which
  // already appears to be quoted.
  let needsQuote = false;
  if (text[0] != '"' && qchars != '') {
    for (let i = 0; i < text.length; i++) {
      if (qchars.contains(text[i])) {
        needsQuote = true;
        break;
      }
    }
  }

  if (needsQuote)
    text = '"' + text.replace(/["\\]/g, "\\$&") + '"';
  return this.addText(text, mayBreakAfter);
};

/**
 * Adds a block of text that corresponds to the phrase production in RFC 5322.
 * Such text is a sequence of atoms, quoted-strings, or RFC-2047 encoded-words.
 * This method will preprocess input to normalize all space sequences to a
 * single space.
 *
 * Unlike the above methods, this will throw if the phrase could not be added to
 * the output.
 *
 * @param text          The text to add to the output.
 * @param qchars        The set of characters that cannot appear outside of a
 *                      quoted string.
 * @param mayBreakAfter If true, the current position in the output is a
 *                      candidate for inserting a line break.
 */
HeaderAssembler.prototype.addPhrase = function (text, qchars, mayBreakAfter) {
  // Collapse all whitespace spans into a single whitespace node.
  let text = text.replace(/[ \t\r\n]+/g, " ");

  // If we have non-ASCII text, encode it using RFC 2047.
  if (this._use2047 && nonAsciiRe.test(text)) {
    this.encodeRFC2047Phrase(text, mayBreakAfter);
    return;
  }

  if (this.addQuotable(text, qchars, mayBreakAfter)) {
    // If we failed to add the quoted string, our input was way too long. Try
    // splitting the quotable at space boundaries and adding each word
    // individually. If those fail, we throw an unencodable error.
    let words = text.split(' ');
    for (let i = 0; i < words.length; i++) {
      if (this.addQuotable(words[i], qchars,
          i == words.length - 1 ? mayBreakAfter : true))
        throw new Error("Cannot encode " + words[i] + " due to length");
    }
  } else if (this._lastSplitPoint == 0 && text.contains(" ")) {
    if (this._currentLine[this._currentLine.length - 1] != '"')
      this._lastSplitPoint = this._currentLine.lastIndexOf(" ");
  }
};

/// A regular expression for characters that need to be encoded.
let nonAsciiRe = /[^\x20-\x7e]/;

/// The beginnings of RFC 2047 encoded-word
let b64Prelude = "=?UTF-8?B?", qpPrelude = "=?UTF-8?Q?";

/// A list of ASCII characters forbidden in RFC 2047 encoded-words
let qpForbidden = "=?_()\"";

/**
 * Add a block of text as a single RFC 2047 encoded word. This does not try to
 * split words if they are too long.
 *
 * @param encodedText   A typed array of octets to encode.
 * @param useQP         Whether or not to use base64 or quoted-printable.
 * @param mayBreakAfter If true, the current position in the output is a
 *                      candidate for inserting a line break.
 * @param qpForbidden   A set of ASCII characters that need encoding in
 *                      quoted-printable mode.
 */
HeaderAssembler.prototype._addRFC2047Word = function (encodedText, useQP,
    mayBreakAfter, qpForbidden) {
  let binaryString = String.fromCharCode.apply(undefined, encodedText);
  if (useQP) {
    var token = qpPrelude;
    for (let i = 0; i < encodedText.length; i++) {
      if (encodedText[i] < 0x20 || encodedText[i] >= 0x7F ||
          qpForbidden.contains(binaryString[i])) {
        let ch = encodedText[i];
        let hexString = "0123456789abcdef";
        token += "=" + hexString[(ch & 0xf0) >> 4] + hexString[ch & 0x0f];
      } else if (binaryString[i] == " ") {
        token += "_";
      } else {
        token += binaryString[i];
      }
    }
    token += "?=";
  } else {
    var token = b64Prelude + btoa(binaryString) + "?=";
  }
  this.addText(token, mayBreakAfter);
};

/**
 * Add a block of text as potentially several RFC 2047 encoded-word tokens.
 *
 * @param text          The text to add to the output.
 * @param mayBreakAfter If true, the current position in the output is a
 *                      candidate for inserting a line break.
 */
HeaderAssembler.prototype.encodeRFC2047Phrase = function (text, mayBreakAfter) {
  // Start by encoding the text into UTF-8 directly.
  let encodedText = new TextEncoder("UTF-8").encode(text);

  // Make sure there's enough room for a single token.
  let minLineLen = b64Prelude.length + 10; // Ten base64 bytes plus ?=
  if (!this._reserveTokenSpace(minLineLen)) {
    this._output += '\r\n ' + this._currentLine;
    this._currentLine = '';
    this._charsRemaining = this._maxLineLen - 1;
  }

  // Try to encode as much UTF-8 text as possible in each go.
  let b64Len = 0, qpLen = 0, start = 0;
  let maxChars = this._charsRemaining - (b64Prelude.length + 2);
  for (let i = 0; i < encodedText.length; i++) {
    let b64Inc = 0, qpInc = 0;
    // The length we need for base64 is ceil(length / 3) * 4...
    if ((i - start) % 3 == 0)
      b64Inc += 4;

    // The length for quoted-printable is 3 chars only if encoded
    if (encodedText[i] < 0x20 || encodedText[i] >= 0x7f ||
        qpForbidden.contains(String.fromCharCode(encodedText[i]))) {
      qpInc = 3;
    } else {
      qpInc = 1;
    }

    if (b64Len + b64Inc > maxChars && qpLen + qpInc > maxChars) {
      // Oops, we have too many characters! We need to encode everything through
      // the current character. However, we can't split in the middle of a
      // multibyte character. In UTF-8, characters that start with 10xx xxxx are
      // the middle of multibyte characters, so backtrack until the start
      // character is legal.
      while ((encodedText[i] & 0xC0) == 0x80)
        --i;

      // Add this part of the word and then make a continuation.
      this._addRFC2047Word(encodedText.subarray(start, i - start),
        b64Len >= qpLen, true, qpForbidden);

      // Reset the array for parsing.
      start = i;
      --i; // Reparse this character as well
      b64Len = qpLen = 0;
      maxChars = this._maxLineLen - b64Prelude - 3;
    } else {
      // Add the counts for the current variable to the count to encode.
      b64Len += b64Inc;
      qpLen += qpInc;
    }
  }

  // Add the entire array at this point.
  this._addRFC2047Word(encodedText.subarray(start), b64Len >= qpLen,
    mayBreakAfter, qpForbidden);
};

////////////////////////
// High-level methods //
////////////////////////

/**
 * Add a single address to the header, where the input is an object that
 * contains the properties name and email, corresponding to the display name and
 * the email address to be added.
 *
 * @param addr The address to be added.
 */
HeaderAssembler.prototype.addAddress = function (addr) {
  // If we have a display name, add that first.
  if (addr.name) {
    this.addPhrase(addr.name, ",()<>:;.\"", false);
    this.addText(" <", false);
  }

  // Find the local-part and domain of the address, since the local-part may
  // need to be quoted separately.
  let at = addr.email.lastIndexOf("@");
  let localpart = "", domain = ""
  if (at == -1)
    localpart = addr.email;
  else {
    localpart = addr.email.slice(0, at);
    domain = addr.email.slice(at); // Include the @
  }

  if (this.addQuotable(localpart, "()<>[]:;@\\,\" !", false)) {
    throw new Error("Cannot encode " + localpart + " due to length");
  }
  if (this.addText(domain + (addr.name ? ">" : ""), false)) {
    throw new Error("Cannot encode " + domain + " due to length");
  }
};

/**
 * Add an array of addresses and groups to the output. An address is assumed to
 * be an object containing the properties name and email, while a group is
 * assumed to be an object containing the properties name and members, where
 * name is the display name of the group and members is an array of address
 * objects to add.
 *
 * @param addresses A collection of addresses to add.
 */
HeaderAssembler.prototype.addAddresses = function (addresses) {
  let needsComma = false;
  for (let addr of addresses) {
    // Ignore a dummy empty address.
    if ("email" in addr && addr.email === "")
      continue;

    // Add a comma if this is not the first element.
    if (needsComma)
      this.addText(", ", true);
    needsComma = true;

    if ("email" in addr) {
      this.addAddress(addr);
    } else {
      // A group has format name: member, member;
      // Note that we still add a comma after the group is completed.
      this.addPhrase(addr.name, ",()<>:;.\"", false);
      this.addText(":", true);

      this.addAddresses(addr.members);
      this.addText(";", true);
    }
  }
};

/**
 * Add an unstructured header value to the output.
 *
 * @param text The text to add to the output.
 */
HeaderAssembler.prototype.addUnstructured = function (text) {
  // Unstructured text is basically a phrase that can't be quoted. So, if we
  // have nothing in qchars, nothing should be quoted.
  this.addPhrase(text, "", false);
};

/// Retrieve the output of the header as a string.
HeaderAssembler.prototype.getOutput = function () {
  return this._output + this._currentLine.trimRight();
};

global.HeaderAssembler = HeaderAssembler;
})(this);

