'use strict';
/*
 * THE SONGS BANK'S BUILT-IN CATALOGUE.
 *
 * Song ENTRIES, not song words: title, who wrote it, the year, what it is for,
 * and the shape it is normally sung in (Verse 1 · Chorus · Bridge…). Deliberately
 * no lyrics, for a reason that matters to the church rather than to the app:
 *
 *   Worship lyrics are copyrighted, and reproducing them is precisely what a
 *   CCLI licence covers. A church holds that licence; an app that shipped the
 *   words would be putting its own copy in front of the congregation under
 *   somebody else's name. So the words come from the church — typed once,
 *   pasted from their own files, or copied out of their CCLI SongSelect
 *   subscription — and from then on the bank keeps them.
 *
 * That is not a limitation dressed up: it is what makes the bank yours. The
 * catalogue below is the scaffolding — pick a song and you get it named,
 * credited, themed and pre-sectioned, ready for the words. Every song already
 * in the operator's Library can be poured into the bank in one press
 * (`songbank.merge`), which is how a church that has been using the studio for
 * a month ends up with a bank full of its OWN arrangements on day one.
 *
 * `sections` is the shape the song is usually sung in. It becomes the slide
 * tags, so an empty song still arrives with Verse 1 / Chorus / Bridge in the
 * right order and the words drop straight in.
 */

const V1C = ['Verse 1', 'Chorus', 'Verse 2', 'Chorus'];
const V1CB = ['Verse 1', 'Chorus', 'Verse 2', 'Chorus', 'Bridge', 'Chorus'];
const V1PCB = ['Verse 1', 'Pre-Chorus', 'Chorus', 'Verse 2', 'Pre-Chorus', 'Chorus', 'Bridge', 'Chorus'];
const HYMN4 = ['Verse 1', 'Verse 2', 'Verse 3', 'Verse 4'];
const HYMN4C = ['Verse 1', 'Chorus', 'Verse 2', 'Chorus', 'Verse 3', 'Chorus', 'Verse 4', 'Chorus'];
const HYMN3C = ['Verse 1', 'Chorus', 'Verse 2', 'Chorus', 'Verse 3', 'Chorus'];

/* Themes are what an operator actually plans a service by — the set a song goes
 * in, not a musicologist's genre. They drive the filter chips. */
const THEMES = ['Praise', 'Worship', 'Thanksgiving', 'Grace', 'The cross', 'Communion',
  'Altar call', 'Faith', 'Christmas', 'Easter', 'Hymn'];

const S = (title, author, year, themes, sections, extra) => Object.assign({
  id: 'bank-' + String(title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
  title, author: author || '', year: year || 0,
  themes: themes || [], sections: sections || V1CB,
  words: '',            // the church's own words, added later — see songbank.js
  ccli: '', key: '',
  source: 'builtin',
}, extra || {});

/* ---------------------------- contemporary ------------------------------ */
const CONTEMPORARY = [
  S('Way Maker', 'Sinach', 2015, ['Worship', 'Faith'], V1CB),
  S('What A Beautiful Name', 'Hillsong Worship', 2016, ['Worship'], V1CB),
  S('Goodness Of God', 'Bethel Music', 2018, ['Worship', 'Thanksgiving'], V1CB),
  S('10,000 Reasons (Bless The Lord)', 'Matt Redman', 2011, ['Praise', 'Thanksgiving'], V1CB),
  S('Great Are You Lord', 'All Sons & Daughters', 2013, ['Worship'], V1CB),
  S('Build My Life', 'Pat Barrett', 2016, ['Worship'], V1CB),
  S('Living Hope', 'Phil Wickham', 2018, ['The cross', 'Easter'], V1CB),
  S('King Of Kings', 'Hillsong Worship', 2019, ['Worship', 'Easter'], V1CB),
  S('Graves Into Gardens', 'Elevation Worship', 2020, ['Worship', 'Faith'], V1PCB),
  S('The Blessing', 'Kari Jobe & Cody Carnes', 2020, ['Worship'], ['Verse 1', 'Chorus', 'Bridge', 'Chorus']),
  S('Jireh', 'Elevation Worship & Maverick City', 2021, ['Worship', 'Faith'], V1CB),
  S('Holy Forever', 'Chris Tomlin', 2022, ['Worship', 'Praise'], V1CB),
  S('Gratitude', 'Brandon Lake', 2020, ['Thanksgiving', 'Worship'], V1CB),
  S('Firm Foundation (He Won’t)', 'Cody Carnes', 2022, ['Faith'], V1CB),
  S('Praise', 'Elevation Worship', 2023, ['Praise'], V1PCB),
  S('Trust In God', 'Elevation Worship', 2022, ['Faith'], V1CB),
  S('Same God', 'Elevation Worship', 2022, ['Faith'], V1CB),
  S('Cornerstone', 'Hillsong Worship', 2012, ['Worship', 'Faith'], V1CB),
  S('How Great Is Our God', 'Chris Tomlin', 2004, ['Praise'], V1CB),
  S('Blessed Be Your Name', 'Matt Redman', 2002, ['Praise', 'Faith'], V1PCB),
  S('Oceans (Where Feet May Fail)', 'Hillsong UNITED', 2013, ['Worship', 'Faith'], V1CB),
  S('In Christ Alone', 'Keith Getty & Stuart Townend', 2001, ['The cross', 'Hymn'], HYMN4),
  S('Reckless Love', 'Cory Asbury', 2017, ['Worship', 'Grace'], V1CB),
  S('Who You Say I Am', 'Hillsong Worship', 2018, ['Worship', 'Grace'], V1CB),
  S('O Come To The Altar', 'Elevation Worship', 2015, ['Altar call', 'Grace'], V1CB),
  S('Good Good Father', 'Chris Tomlin', 2014, ['Worship'], V1CB),
  S('Do It Again', 'Elevation Worship', 2017, ['Faith'], V1CB),
  S('Raise A Hallelujah', 'Bethel Music', 2018, ['Praise', 'Faith'], V1CB),
  S('Yes I Will', 'Vertical Worship', 2018, ['Faith'], V1CB),
  S('Battle Belongs', 'Phil Wickham', 2020, ['Faith'], V1CB),
  S('Hymn Of Heaven', 'Phil Wickham', 2021, ['Worship'], V1CB),
  S('I Speak Jesus', 'Here Be Lions', 2019, ['Worship'], V1CB),
  S('Great Things', 'Phil Wickham', 2018, ['Praise'], V1CB),
  S('Christ Be Magnified', 'Cody Carnes', 2019, ['Worship'], V1CB),
  S('Million Little Miracles', 'Elevation Worship & Maverick City', 2023, ['Thanksgiving'], V1CB),
  S('Egypt', 'Cory Asbury', 2020, ['Faith'], V1CB),
  S('Jesus At The Center', 'Israel Houghton', 2011, ['Worship'], V1CB),
  S('This Is Amazing Grace', 'Phil Wickham', 2013, ['Praise', 'Grace'], V1CB),
  S('Here I Am To Worship', 'Tim Hughes', 2000, ['Worship'], V1CB),
  S('Mighty To Save', 'Hillsong Worship', 2006, ['Worship', 'Grace'], V1CB),
  S('Goodness Of Jesus', 'CityAlight', 2022, ['Worship'], V1CB),
  S('Yet Not I But Through Christ In Me', 'CityAlight', 2018, ['Grace', 'Hymn'], HYMN4),
];

/* --------------------- widely sung across West Africa -------------------- */
/* Nigerian and pan-African worship is a large part of a great many services and
 * is missing from every catalogue built for an American church. */
const AFRICAN = [
  S('I Know Who I Am', 'Sinach', 2013, ['Worship', 'Faith'], V1CB),
  S('Great Are You Lord (Nara)', 'Tim Godfrey ft. Travis Greene', 2016, ['Praise'], V1CB),
  S('Imela', 'Nathaniel Bassey ft. Enitan Adaba', 2014, ['Thanksgiving'], V1CB),
  S('Onise Iyanu', 'Nathaniel Bassey ft. Micah Stampley', 2016, ['Worship'], V1CB),
  S('Olowogbogboro', 'Nathaniel Bassey', 2016, ['Worship'], V1CB),
  S('You Are Great', 'Nathaniel Bassey', 2017, ['Praise'], V1CB),
  S('Ekwueme', 'Prospa Ochimana ft. Osinachi Nwachukwu', 2017, ['Worship'], V1CB),
  S('Na You Dey Reign', 'Nathaniel Bassey', 2018, ['Worship'], V1CB),
  S('Excess Love', 'Mercy Chinwo', 2018, ['Worship', 'Grace'], V1CB),
  S('Obinasom', 'Mercy Chinwo', 2019, ['Worship'], V1CB),
  S('Amen', 'Nathaniel Bassey', 2020, ['Praise'], V1CB),
  S('Emmanuel (God With Us)', 'Nathaniel Bassey', 2021, ['Christmas', 'Worship'], V1CB),
  S('Miracle No Dey Tire Jesus', 'Moses Bliss', 2021, ['Faith'], V1CB),
  S('Bigger Than', 'Moses Bliss', 2022, ['Praise'], V1CB),
  S('Odogwu', 'Tim Godfrey', 2021, ['Praise'], V1CB),
  S('Way Maker (Yoruba)', 'Sinach', 2015, ['Worship'], V1CB),
];

/* ------------------------------- the hymns ------------------------------- */
/* Old enough that most churches sing them from memory, and the ones a service
 * still falls back on for communion, the altar call and the seasons. */
const HYMNS = [
  S('Amazing Grace', 'John Newton', 1779, ['Grace', 'Hymn'], HYMN4),
  S('How Great Thou Art', 'Stuart K. Hine', 1949, ['Praise', 'Hymn'], HYMN4C),
  S('Great Is Thy Faithfulness', 'Thomas O. Chisholm', 1923, ['Thanksgiving', 'Hymn'], HYMN3C),
  S('It Is Well With My Soul', 'Horatio G. Spafford', 1873, ['Faith', 'Hymn'], HYMN4C),
  S('Holy, Holy, Holy', 'Reginald Heber', 1826, ['Worship', 'Hymn'], HYMN4),
  S('Blessed Assurance', 'Fanny J. Crosby', 1873, ['Grace', 'Hymn'], HYMN3C),
  S('Come, Thou Fount Of Every Blessing', 'Robert Robinson', 1758, ['Worship', 'Hymn'], ['Verse 1', 'Verse 2', 'Verse 3']),
  S('Be Thou My Vision', 'Traditional Irish', 1912, ['Worship', 'Hymn'], HYMN4),
  S('What A Friend We Have In Jesus', 'Joseph M. Scriven', 1855, ['Faith', 'Hymn'], ['Verse 1', 'Verse 2', 'Verse 3']),
  S('To God Be The Glory', 'Fanny J. Crosby', 1875, ['Praise', 'Hymn'], HYMN3C),
  S('The Old Rugged Cross', 'George Bennard', 1913, ['The cross', 'Hymn'], HYMN4C),
  S('When I Survey The Wondrous Cross', 'Isaac Watts', 1707, ['The cross', 'Communion', 'Hymn'], HYMN4),
  S('I Surrender All', 'Judson W. Van DeVenter', 1896, ['Altar call', 'Hymn'], HYMN4C),
  S('Just As I Am', 'Charlotte Elliott', 1835, ['Altar call', 'Hymn'], HYMN4),
  S('Nothing But The Blood', 'Robert Lowry', 1876, ['The cross', 'Communion', 'Hymn'], HYMN4C),
  S('Doxology (Praise God, From Whom All Blessings Flow)', 'Thomas Ken', 1674, ['Praise', 'Hymn'], ['Verse 1']),
  S('My Hope Is Built (The Solid Rock)', 'Edward Mote', 1834, ['Faith', 'Hymn'], HYMN4C),
  S('A Mighty Fortress Is Our God', 'Martin Luther', 1529, ['Faith', 'Hymn'], HYMN4),
  S('Crown Him With Many Crowns', 'Matthew Bridges', 1851, ['Worship', 'Hymn'], HYMN4),
  S('Praise To The Lord, The Almighty', 'Joachim Neander', 1680, ['Praise', 'Hymn'], HYMN4),
  S('Immortal, Invisible, God Only Wise', 'Walter Chalmers Smith', 1867, ['Worship', 'Hymn'], HYMN4),
  S('Turn Your Eyes Upon Jesus', 'Helen H. Lemmel', 1922, ['Worship', 'Hymn'], HYMN3C),
  S('Trust And Obey', 'John H. Sammis', 1887, ['Faith', 'Hymn'], HYMN4C),
  S('Take My Life And Let It Be', 'Frances R. Havergal', 1874, ['Altar call', 'Hymn'], HYMN4),
  S('Abide With Me', 'Henry F. Lyte', 1847, ['Faith', 'Hymn'], HYMN4),
  S('Jesus Paid It All', 'Elvina M. Hall', 1865, ['The cross', 'Hymn'], HYMN4C),
  S('Because He Lives', 'Bill & Gloria Gaither', 1971, ['Easter', 'Faith'], HYMN3C),
  S('Christ The Lord Is Risen Today', 'Charles Wesley', 1739, ['Easter', 'Hymn'], HYMN4),
  S('Up From The Grave He Arose', 'Robert Lowry', 1874, ['Easter', 'Hymn'], HYMN3C),
  S('Softly And Tenderly', 'Will L. Thompson', 1880, ['Altar call', 'Hymn'], HYMN4C),
  S('Standing On The Promises', 'R. Kelso Carter', 1886, ['Faith', 'Hymn'], HYMN4C),
  S('When We All Get To Heaven', 'Eliza E. Hewitt', 1898, ['Praise', 'Hymn'], HYMN4C),
  S('Power In The Blood', 'Lewis E. Jones', 1899, ['The cross', 'Hymn'], HYMN4C),
  S('Blessed Be The Name', 'Ralph E. Hudson', 1898, ['Praise', 'Hymn'], HYMN4C),
  S('O Worship The King', 'Robert Grant', 1833, ['Worship', 'Hymn'], HYMN4),
  S('Love Divine, All Loves Excelling', 'Charles Wesley', 1747, ['Worship', 'Hymn'], HYMN4),
  S('O For A Thousand Tongues To Sing', 'Charles Wesley', 1739, ['Praise', 'Hymn'], HYMN4),
  S('Now Thank We All Our God', 'Martin Rinkart', 1636, ['Thanksgiving', 'Hymn'], ['Verse 1', 'Verse 2', 'Verse 3']),
  S('Come, Ye Thankful People, Come', 'Henry Alford', 1844, ['Thanksgiving', 'Hymn'], HYMN4),
  S('Let Us Break Bread Together', 'Traditional spiritual', 1925, ['Communion', 'Hymn'], ['Verse 1', 'Verse 2', 'Verse 3']),
  S('Here, O My Lord, I See Thee Face To Face', 'Horatius Bonar', 1855, ['Communion', 'Hymn'], HYMN4),
  S('O Come, All Ye Faithful', 'John F. Wade', 1751, ['Christmas', 'Hymn'], HYMN4C),
  S('Silent Night', 'Joseph Mohr', 1818, ['Christmas', 'Hymn'], ['Verse 1', 'Verse 2', 'Verse 3']),
  S('Joy To The World', 'Isaac Watts', 1719, ['Christmas', 'Hymn'], HYMN4),
  S('Hark! The Herald Angels Sing', 'Charles Wesley', 1739, ['Christmas', 'Hymn'], ['Verse 1', 'Verse 2', 'Verse 3']),
  S('O Holy Night', 'Adolphe Adam', 1847, ['Christmas', 'Hymn'], ['Verse 1', 'Chorus', 'Verse 2', 'Chorus']),
];

const CATALOGUE = [].concat(CONTEMPORARY, AFRICAN, HYMNS);

module.exports = { CATALOGUE, THEMES };
