/*
 * The corpora. Shared by the tuning harness and the real test.
 *
 * FAMOUS: what a preacher actually says — quoted from memory, so the wording
 * wanders, and passed through a speech recogniser, so a word here and there is
 * wrong. Every reference in here is CHECKED against the text at load time by
 * the harness, so a mistake of mine cannot quietly become the expected answer.
 *
 * PREACHING: the other thirty-nine minutes. Ordinary sermon speech, testimony,
 * announcements, prayer and song lyrics — prayer especially, because prayer
 * language is deliberately biblical and is the hardest thing to stay quiet
 * through. Not one line here may put a verse on the wall.
 */

const FAMOUS = [
  // --- said almost exactly, in the wording most people learned ---
  ['give and it shall be given unto you', 'Luke 6:38'],
  ['for god so loved the world that he gave his only begotten son', 'John 3:16'],
  ['the lord is my shepherd i shall not want', 'Psalms 23:1'],
  ['i can do all things through christ which strengtheneth me', 'Philippians 4:13'],
  ['in the beginning god created the heaven and the earth', 'Genesis 1:1'],
  ['trust in the lord with all thine heart and lean not unto thine own understanding', 'Proverbs 3:5'],
  ['come unto me all ye that labour and are heavy laden and i will give you rest', 'Matthew 11:28'],
  ['and we know that all things work together for good to them that love god', 'Romans 8:28'],
  ['be still and know that i am god', 'Psalms 46:10'],
  ['i am the way the truth and the life no man cometh unto the father but by me', 'John 14:6'],
  ['for the wages of sin is death but the gift of god is eternal life', 'Romans 6:23'],
  ['let not your heart be troubled ye believe in god believe also in me', 'John 14:1'],
  ['ask and it shall be given you seek and ye shall find knock and it shall be opened', 'Matthew 7:7'],
  ['now faith is the substance of things hoped for the evidence of things not seen', 'Hebrews 11:1'],
  ['train up a child in the way he should go', 'Proverbs 22:6'],
  ['the lord bless thee and keep thee', 'Numbers 6:24'],
  ['for i know the thoughts that i think toward you saith the lord', 'Jeremiah 29:11'],
  ['but they that wait upon the lord shall renew their strength', 'Isaiah 40:31'],
  ['thy word is a lamp unto my feet and a light unto my path', 'Psalms 119:105'],
  ['for by grace are ye saved through faith and that not of yourselves', 'Ephesians 2:8'],
  ['casting all your care upon him for he careth for you', '1 Peter 5:7'],
  ['be careful for nothing but in every thing by prayer and supplication', 'Philippians 4:6'],
  ['i am crucified with christ nevertheless i live', 'Galatians 2:20'],
  ['the joy of the lord is your strength', 'Nehemiah 8:10'],
  ['create in me a clean heart o god and renew a right spirit within me', 'Psalms 51:10'],
  ['delight thyself also in the lord and he shall give thee the desires of thine heart', 'Psalms 37:4'],
  ['seek ye first the kingdom of god and his righteousness', 'Matthew 6:33'],
  ['a soft answer turneth away wrath', 'Proverbs 15:1'],
  ['iron sharpeneth iron so a man sharpeneth the countenance of his friend', 'Proverbs 27:17'],
  ['and ye shall know the truth and the truth shall make you free', 'John 8:32'],
  ['jesus wept', null],                                    // too short to act on
  ['greater is he that is in you than he that is in the world', '1 John 4:4'],
  ['for all have sinned and come short of the glory of god', 'Romans 3:23'],
  ['there is therefore now no condemnation to them which are in christ jesus', 'Romans 8:1'],
  ['if my people which are called by my name shall humble themselves and pray', '2 Chronicles 7:14'],
  ['weeping may endure for a night but joy cometh in the morning', 'Psalms 30:5'],
  ['the steps of a good man are ordered by the lord', 'Psalms 37:23'],
  ['no weapon that is formed against thee shall prosper', 'Isaiah 54:17'],
  ['he was wounded for our transgressions he was bruised for our iniquities', 'Isaiah 53:5'],
  ['behold i stand at the door and knock', 'Revelation 3:20'],
  ['i am the vine ye are the branches', 'John 15:5'],
  // said word for word in three places — any of them is a right answer
  ['whosoever shall call upon the name of the lord shall be saved', ['Romans 10:13', 'Acts 2:21', 'Joel 2:32']],
  ['and now abideth faith hope charity these three but the greatest of these is charity', '1 Corinthians 13:13'],
  ['my grace is sufficient for thee for my strength is made perfect in weakness', '2 Corinthians 12:9'],
  ['finally my brethren be strong in the lord and in the power of his might', 'Ephesians 6:10'],
  ['for god hath not given us the spirit of fear but of power and of love', '2 Timothy 1:7'],
  ['every good gift and every perfect gift is from above', 'James 1:17'],
  ['submit yourselves therefore to god resist the devil and he will flee from you', 'James 4:7'],
  ['if we confess our sins he is faithful and just to forgive us our sins', '1 John 1:9'],
  ['the thief cometh not but for to steal and to kill and to destroy', 'John 10:10'],
  ['i am the good shepherd the good shepherd giveth his life for the sheep', 'John 10:11'],
  ['go ye therefore and teach all nations baptizing them', 'Matthew 28:19'],
  ['ye are the light of the world a city that is set on an hill cannot be hid', 'Matthew 5:14'],
  ['blessed are the poor in spirit for theirs is the kingdom of heaven', 'Matthew 5:3'],
  ['man shall not live by bread alone but by every word that proceedeth out of the mouth of god', 'Matthew 4:4'],
  ['this is the day which the lord hath made we will rejoice and be glad in it', 'Psalms 118:24'],
  ['god is our refuge and strength a very present help in trouble', 'Psalms 46:1'],
  ['bless the lord o my soul and all that is within me bless his holy name', 'Psalms 103:1'],
  ['i will lift up mine eyes unto the hills from whence cometh my help', 'Psalms 121:1'],
  ['thou wilt keep him in perfect peace whose mind is stayed on thee', 'Isaiah 26:3'],
  ['come now and let us reason together saith the lord', 'Isaiah 1:18'],
  ['and the word was made flesh and dwelt among us', 'John 1:14'],
  ['in my fathers house are many mansions', 'John 14:2'],
  ['what shall it profit a man if he shall gain the whole world and lose his own soul', 'Mark 8:36'],
  ['with god all things are possible', ['Matthew 19:26', 'Mark 10:27', 'Mark 14:36', 'Luke 18:27']],
  ['let this mind be in you which was also in christ jesus', 'Philippians 2:5'],
  ['and my god shall supply all your need according to his riches in glory', 'Philippians 4:19'],
  ['whatsoever a man soweth that shall he also reap', 'Galatians 6:7'],
  ['the fruit of the spirit is love joy peace longsuffering gentleness goodness faith', 'Galatians 5:22'],
  ['study to shew thyself approved unto god a workman that needeth not to be ashamed', '2 Timothy 2:15'],
  ['for where two or three are gathered together in my name there am i in the midst', 'Matthew 18:20'],
  ['and let us not be weary in well doing for in due season we shall reap', 'Galatians 6:9'],
  ['thou shalt love the lord thy god with all thy heart', ['Matthew 22:37', 'Deuteronomy 6:5', 'Mark 12:30', 'Luke 10:27']],
  ['a merry heart doeth good like a medicine', 'Proverbs 17:22'],
  ['pride goeth before destruction and an haughty spirit before a fall', 'Proverbs 16:18'],
  ['commit thy works unto the lord and thy thoughts shall be established', 'Proverbs 16:3'],
  ['the fear of the lord is the beginning of wisdom', ['Proverbs 9:10', 'Psalms 111:10', 'Proverbs 1:7']],
  ['he that dwelleth in the secret place of the most high', 'Psalms 91:1'],
  ['surely goodness and mercy shall follow me all the days of my life', 'Psalms 23:6'],
  ['yea though i walk through the valley of the shadow of death i will fear no evil', 'Psalms 23:4'],
  /*
   * SHORT AND FAMOUS (v2.77). Five or six words, and only a third of their
   * verse, so neither the seven-in-a-row rule nor the most-of-the-verse rule
   * lets them up. What does is that the Bibles AGREE — nearly every one of the
   * twelve names the same verse. See agreeMin in versefind.js. Each of these was
   * said, just like this, in one of this church's own services.
   */
  ['with god all things are possible', ['Matthew 19:26', 'Mark 10:27']],
  ['in the valley of decision', 'Joel 3:14'],
  ['And Jesus said, I will build my church,', 'Matthew 16:18'],
  ['Your old men shall dream dreams.', ['Joel 2:28', 'Acts 2:17']],
  ['They turn the world upside down.', 'Acts 17:6'],
];

/* Quoted the way people actually misremember, or the way whisper mishears.
 * Same expected answers — this is the same passage arriving damaged. */
const LOOSE = [
  /*
   * MOVED HERE FROM PREACHING (v2.77). It was listed as a line that must stay
   * silent, but its middle sentence is Matthew 6:8 in the NIV word for word —
   * "your Father knows what you need before you ask him" — eight words in a
   * row. The matcher only used to look at the END of what was said, so it
   * never saw it; now that every sentence is judged on its own it does, and
   * putting Matthew 6:8 up for it is right. "It must find more of the verses
   * they quote" was the request, and this is one.
   */
  ['He is a good father. He knows what you need before you ask him. Somebody give him praise this morning.', 'Matthew 6:8'],
  /*
   * MOVED HERE FROM PREACHING (v2.77), for the same reason. Eight words of
   * Psalm 150:6 in a row, and it is Psalm 150:6. It was listed as silent
   * because a worship leader says it with a song on the wall — and that is now
   * the studio's decision, not the matcher's: while the words heard are the
   * words on the live slide, nothing is put up (singsWhatIsShown in
   * present.js, tested by test:presentquote). The matcher's job is to know a
   * quotation; this is one. Silencing it here needed the old share bar of
   * 0.62, and replayed through 13.8 hours of this church's services that bar
   * missed fifteen genuine quotations that 0.4 finds.
   */
  ['let everything that has breath praise the lord somebody sing it', 'Psalms 150:6'],
  // a real quotation with six words of throat-clearing in front of it
  ['you have got to understand that faith without works is dead', ['James 2:20', 'James 2:26']],
  ['love is patient love is kind it does not envy it does not boast', '1 Corinthians 13:4'],  // KJV says 'charity suffereth long' — only a modern index can find this
  ['give and it will be given to you', 'Luke 6:38'],                        // modern wording
  ['for god so loved the world he gave his only son', 'John 3:16'],         // dropped words
  ['the lord is my shepherd i shall not be in want', 'Psalms 23:1'],
  ['i can do all things through christ who strengthens me', 'Philippians 4:13'],
  ['trust in the lord with all your heart and lean not on your own understanding', 'Proverbs 3:5'],
  ['come to me all you who are weary and burdened and i will give you rest', 'Matthew 11:28'],
  ['and we know that all things work together for the good of those who love god', 'Romans 8:28'],
  ['i am the way and the truth and the life no one comes to the father except through me', 'John 14:6'],
  ['for the wages of sin is death but the gift of god is eternal life in christ jesus', 'Romans 6:23'],
  ['ask and it will be given to you seek and you will find', 'Matthew 7:7'],
  ['now faith is being sure of what we hope for and certain of what we do not see', 'Hebrews 11:1'],
  ['they that wait on the lord will renew their strength they will mount up with wings', 'Isaiah 40:31'],
  ['your word is a lamp to my feet and a light for my path', 'Psalms 119:105'],
  ['cast all your anxiety on him because he cares for you', '1 Peter 5:7'],
  ['seek first the kingdom of god and his righteousness', 'Matthew 6:33'],
  ['then you will know the truth and the truth will set you free', 'John 8:32'],
  ['for all have sinned and fall short of the glory of god', 'Romans 3:23'],
  ['no weapon formed against you shall prosper', 'Isaiah 54:17'],
  ['the thief comes only to steal and kill and destroy', 'John 10:10'],
  ['everyone who calls on the name of the lord will be saved', ['Romans 10:13', 'Acts 2:21', 'Joel 2:32']],
  // one word plainly misheard by the recogniser
  ['for god so loved the world that he gave his only forgotten son', 'John 3:16'],
  ['trust in the lord with all your heart and lean not on your own understand', 'Proverbs 3:5'],
  ['the lord is my shepherd i shall not want he maketh me to lie down in green pastors', 'Psalms 23:1'],
  ['be still and know that i am gone', 'Psalms 46:10'],
  /*
   * THE SHAPE A ROLLING LOOK-BACK ACTUALLY ARRIVES IN.
   *
   * The live ear no longer waits for a pause that a preacher in full flow never
   * takes — it offers the last few seconds over and over, so what the matcher
   * is handed is several sentences with the quotation somewhere at the end of
   * them, punctuation and all. Measured on a real sermon, a quotation buried in
   * eight seconds of surrounding speech scored well under the bar on the whole
   * text and cleanly over it on its own sentence, which is why the matcher is
   * allowed to consider the speaker's last sentence separately. These are what
   * that permission is for; the multi-sentence lines in PREACHING are what
   * keeps it honest.
   */
  /*
   * NOT ONE UNCOMMON WORD IN IT, AND STILL A QUOTATION. Reported from a real
   * service: this arrived, matched Matthew 7:7 with seven words in a row and
   * nothing else said — share 1.00, coverage 1.00 — and was refused because
   * seven common words weigh 9.4 against a floor of 10. See `isTheVerse` in
   * versefind.js; the stock phrases the floor exists for are all in PREACHING
   * below, and the longest of them reaches five.
   */
  ['And it shall be given to you.', ['Matthew 7:7', 'Luke 6:38', 'Luke 11:9']],
  ['and it shall be given unto you', ['Matthew 7:7', 'Luke 6:38', 'Luke 11:9']],
  ['I mean the rod of God, the rod of Moses became the rod of God. Give, and it shall be given unto you.', 'Luke 6:38'],
  ['And that is why I keep saying it. Trust in the Lord with all thine heart, and lean not unto thine own understanding.', 'Proverbs 3:5'],
  ['Somebody shout amen. For God so loved the world, that he gave his only begotten son.', 'John 3:16'],
  ['We were talking about this last week, were we not? I can do all things through Christ which strengtheneth me.', 'Philippians 4:13'],
  ['Put your hand on your chest and say it with me. The Lord is my shepherd, I shall not want.', 'Psalms 23:1'],
];

/* The other thirty-nine minutes. Nothing here may put a verse on the wall. */
const PREACHING = [
  // ordinary sermon speech
  'good morning church it is so good to see you all here today',
  'we are going to be talking about faith this morning',
  'i want you to turn to your neighbour and say god is good',
  'now that is something we all need to think about is it not',
  'when i was a young man i worked in a factory in birmingham',
  'and the pastor said to me son you have got to keep going',
  'i believe god is doing something new in this house',
  'so many people are struggling right now with their finances',
  'lets give the lord a great big hand of praise this morning',
  'we will come back to that in a moment but first',
  'my mother used to say that to me when i was growing up',
  'there is a story about a man who lost everything he had',
  'god has been so good to me over these last few years',
  'i want to encourage somebody here this morning do not give up',
  'the enemy wants you to think that it is over but it is not',
  'can i get an amen from somebody in this place tonight',
  'we are believing god for a breakthrough in this church',
  'that is why we fast and that is why we pray',
  'somebody shout hallelujah if you know what i am talking about',
  'he was one of the twelve that walked with jesus every day',
  'now i know some of you have been through a very hard season',
  'and i am telling you today that your latter days will be greater',
  'god is not a man that he should lie somebody say amen',
  'when you give god will give back to you pressed down and running over',
  'i am talking to somebody this morning who needs a miracle',
  'the bible has a lot to say about how we handle our money',
  'we serve a god who still answers prayer in this generation',
  'that is what the word of god says about your situation',
  'i want to talk to you today about the power of forgiveness',
  'some of you came in here this morning carrying a heavy load',
  'and jesus looked at him and he loved him and he said',
  'the disciples did not understand what he was saying to them',
  'peter was the one who always spoke before he thought about it',
  'moses went up on that mountain and he stayed there forty days',
  'david was a young shepherd boy nobody thought much of him',
  'paul wrote that letter from a prison cell in rome',
  'the church at corinth had a lot of problems did it not',
  'now watch this because this is where it gets good',
  'i am going to close in about five minutes i promise you',
  // announcements and housekeeping
  'the offering buckets are at the back please give as you leave',
  'next sunday we have our anniversary service at four o clock',
  'if you are new here today please fill in a welcome card',
  'the youth are meeting on friday night at seven thirty',
  'please make sure your mobile phones are on silent',
  'we have refreshments in the hall after the service',
  'the car park is full so please use the street outside',
  'baptism class starts next week for anyone who is interested',
  // prayer — biblical language, and the hardest thing to stay silent through
  'father we thank you for this day that you have made',
  'lord we come before you this morning with thanksgiving in our hearts',
  'we thank you lord for your goodness and for your mercy toward us',
  'father in the name of jesus we ask that you would move in this place',
  'lord you are worthy to be praised and we give you all the glory',
  'we pray for the sick this morning lord touch their bodies',
  'father we ask for wisdom in every decision we make this week',
  'lord we thank you that you are faithful and your love endures',
  'we bless your holy name father and we lift you up',
  'holy spirit have your way in this service this morning we pray',
  'lord we pray for our nation and for those in authority over us',
  'father we thank you for the blood of jesus that covers us',
  'we ask you lord to open the eyes of our understanding',
  'lord let your kingdom come and let your will be done in this place',
  'we give you thanks father for every good thing you have done',
  // testimony
  'i lost my job in march and i did not know what i was going to do',
  'and then the phone rang and it was a number i did not recognise',
  'my daughter was in hospital for three weeks and we prayed every day',
  'the doctor came back and said he could not explain the results',
  'i have been coming to this church for twenty two years now',
  'when my father passed away god carried me through that time',
  'i was not raised in church i came to the lord at thirty five',
  // song lines and worship talk
  'great is thy faithfulness morning by morning new mercies i see',
  'what a friend we have in jesus all our sins and griefs to bear',
  'how great is our god sing with me how great is our god',
  'there is power in the name of jesus to break every chain',
  'i have decided to follow jesus no turning back no turning back',
  'blessed be the name of the lord blessed be his glorious name',
  'we welcome you holy spirit into this atmosphere right now',
  /*
   * EVERYDAY WORDS THE BIBLES SHARE (v2.77). Each of these is a real line from
   * this church's services, five or six words of some verse, and each went up
   * under the first version of "the translations agree" — which counted a
   * Bible as agreeing if the verse was anywhere in its shortlist. A famous
   * verse is every Bible's ANSWER; these were only on their lists.
   */
  'in the middle of the night, 3am,',
  'according to the will of God',
  'the glory of your name.',
  'brought us to a place.',
  'others to do the same?',
  'You are looking at me.',
  'that you are not consumed.',
  'And they were fasting and praying.',
  // short fragments that must never be enough on their own
  'the word of god',
  'in the name of jesus',
  'praise the lord everybody',
  'god is good all the time',
  'thank you jesus',
  'amen and amen',
  'hallelujah somebody',
  'i say unto you',
  'the lord our god',
  'my brothers and sisters',
  /*
   * SEVERAL SENTENCES AT ONCE — the shape a rolling look-back actually hands
   * over, punctuation and all. These exist because the matcher is allowed to
   * consider the last sentence of what it is given on its own (see tailsOf in
   * versefind.js), and being allowed to do that is exactly what could put a
   * sermon on the wall a clause at a time. Every one of these contains a clause
   * that sounds scriptural; not one of them is a quotation.
   */
  'And I want you to hear me this morning. The disciples did not understand what he was saying to them. They were afraid to ask him.',
  'So I lost my job in March. I did not know what I was going to do. But God had a plan.',
  'Turn to your neighbour and tell them something. Blessed be the name of the Lord. Blessed be his glorious name.',
  'We were praying about it for weeks. And then the phone rang, and it was a number I did not recognise.',
  'That is what the enemy wants you to believe. But you are not what they say you are. You are what God says you are.',
  'Let me tell you what happened next. My daughter was in hospital for three weeks and we prayed every single day.',
  'I am not going to keep you long today. There is power in the name of Jesus to break every chain.',
  /*
   * WHAT A SPEECH RECOGNISER HANDS OVER WHEN IT IS STRUGGLING. Straight off a
   * real sermon: the preacher said "primarily the anointing is a product of the
   * Holy Ghost and diligence" and this is what came back. It used to put Acts
   * 6:3 on the wall, because `primarily` and `emergency` are in no Bible and
   * therefore weighed NOTHING, which left "of the Holy Ghost and" looking like
   * 95% of everything that had been said. See oovIdf in versefind.js.
   */
  'Primarily the emergency product of the Holy Ghost and the...',
  'The children ministry is broken and off. They read children and more than they know.',
  'I want to be happy you did. That is how you be increasing. And my turn increases everything right now.',
];

module.exports = { FAMOUS, LOOSE, PREACHING };
