Code Layout
===========

JSMime is a MIME parsing and composition library that is written completely in
JavaScript using ES6 functionality and WebAPIs (where such APIs exist). There
are a few features for which a standardized WebAPI does not exist; for these,
external JavaScript libraries are used.

The MIME parser consists of three logical phases of translation:

1. Build the MIME (and pseudo-MIME) tree.
2. Convert the MIME tree into a body-and-attachments view.
3. Use the result to drive the message view.

The first stage is located in `mimeParserCore.js`. The later stages are not yet
implemented in JS.

Underlying specifications
=========================

Properly generating or parsing email and news messages requires referring to a
diverse set of specifications. As an aid to anyone who wishes to understand the
underlying capabilities and implementation of this library, the following is a
list of all specifications used in the course of development to the MIME parser.
When a specification has multiple versions, only the newest version is provided.

Basic format of bodies:

* [RFC 2045](http://tools.ietf.org/html/rfc2045):
  MIME Part 1, Format of Internet Message Bodies
* [RFC 2046](http://tools.ietf.org/html/rfc2046):
  MIME Part 2, Media Types

Structured header interpretation:

* [RFC 2047](http://tools.ietf.org/html/rfc2047):
  MIME Part 3, Message Header Extensions for Non-ASCII Text
* [RFC 2231](http://tools.ietf.org/html/rfc2231):
  MIME Parameter Value and Encoded Word Extensions
* [RFC 5322](http://tools.ietf.org/html/rfc5322):
  Internet Message Format
* [RFC 5536](http://tools.ietf.org/html/rfc5536):
  Netnews Article Format
* [RFC 6532](http://tools.ietf.org/html/rfc6532):
  Internationalized Email Headers

Body decoding:
X http://pubs.opengroup.org/onlinepubs/7908799/xcu/uuencode.html -- Uuencode
X http://www.yenc.org/yenc-draft.1.3.txt -- yEnc
X RFC 1741 -- BinHex
X http://msdn.microsoft.com/en-us/library/cc425498%28v=exchg.80%29.aspx -- TNEF
X RFC 3165 -- MIME security with PGP
X RFC 4880 -- OpenPGP (see also RFC 2440)
X RFC 5751 -- S/MIME (see also RFC 3851, RFC 2633)

Other:
X RFC 2387 -- multipart/related
X RFC 2392 -- Content-ID and Message-ID  URLs
X RFC 2557 -- MIME-encapsulated aggegrate documents
* RFC 3501 -- IMAPv4rev1 [partial basis for part numbering]
X RFC 3676 -- text/plain format (format=flowed) (see also RFC 2646)
X RFC 3798 -- Message delivery notification (see also RFC 5337 and RFC 6533)

An unfortunate consequence of historical developments for email is that the set
of specifications for handling email is often an insufficient guide to actually
working with email in practice. For further aid to prospective implementers, the
following list is a list of all deliberate deviations from specification
requirements.

* All three line conventions are treated as a CRLF (`\r`, `\n`, `\r\n`). In this
  parser, it is possible to use a mixture of line endings in the same file,
  although this is highly unlikely to come up in practice.
* The input text need not be either ASCII or UTF-8, as use of other character
  sets without proper wrapping is very common in practice. In this parser, all
  header data is passed through as-is. Header names are canonicalized to
  lowercase using .toLowerCase(), which causes case conversion for non-ASCII
  characters as well. However, even under EAI, header names are supposed to be
  pure ASCII so this should not be an issue in practice. The body is left alone
  unless a charset is specified and recoding is explicitly requested.
* CFWS is permitted in fewer places than the specifications require. This was
  done to match other parsers (including the one this replaced, among others).
  In particular, the Content-Type parameter needs to be a single run of text, so
  "multipart / mixed" would be treated as an invalid type.
* If the first line of a headers block starts with the Berkeley mailbox
  delimiter (From followed by a space), it is ignored.
* A `message/rfc822`-like part may be encoded in quoted-printable or base64,
  while RFC 6532 only permits this for `message/global`.
* Decoding the `%hh` specifiers (per RFC 2231) happens for any parameter that
  contains a `'*'` in its name, regardless of whether or not it is enclosed in a
  string or not.
* RFC 2047 encoded-words may contain embedded spaces.
* RFC 2047 decoding tolerates multibyte characters being split between adjacent
  encoded-words.
* A quoted string whose contents is a full RFC 2047 encoded-word is decoded.
