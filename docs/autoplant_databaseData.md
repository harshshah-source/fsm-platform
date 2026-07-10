SELECT DATABASE();
-> ap_widgets

SHOW TABLES;
alertprocess
alertprocess_seq
backup_progress
dup_detention_id
dup_detention_id_10
execution_status
hibernate_sequence
revinfo
tb_alert
tb_alert_aud
tb_alert_master_config
tb_alert_master_config_aud
tb_bulkuploadjob
tb_csr_history
tb_csr_history_archival
tb_daily_summary
tb_defaultchoosecolumn
tb_defaultchoosecolumn_aud
tb_deviation
tb_deviation_archival
tb_etamaster
tb_farthestidlingpoint
tb_farthestidlingpoint_archival
tb_legmaster
tb_legmaster_archival
tb_staging_trip_event
tb_tollmismatch
tb_tollmismatch_bkp
tb_tollmismatch_history
tb_trip_detention
tb_trip_detention_archival
tb_trip_detention_historical
tb_triplegwise
tb_triplegwise_29062026
tb_triplegwise_bkp_12052026
tb_triplegwise_bkp_21052026
tb_tripmaster
tb_tripmaster_archival
tb_vehicle_distance
tb_vehicle_distance_archival
tb_vehiclemaster
tb_vehiclemaster_logs
tb_vehiclemaster_og
tb_violationconfigmaster
tb_violationconfigmaster_aud
temp_table
temporary_trip_distance
trip_detention_seq
tripreportdata
violationconfig_seq
violationdata
violationdata_seq
violationreportdata
violationtypemaster

SELECT COUNT(*)
FROM information_schema.tables
WHERE table_schema = DATABASE();
54

,
	987654321988					1002	1	HCCBPL_VIZAG	0000873	16058	NAVADEEP TRANSPORT	UNDEPLOYED		OWN							20	TRUCK	1012		AUTOPLANT/FLEETEX/WHEELSEYE														1000	2025-10-08 13:30:25		6970	XYZ TRANSPORTER	3030		true	Re-Mapping	Same Device	NO TRIP > 15 DAYS	1012	NOT ON TIME	CURRENT	2020-07-05 18:23:10	TATA	2008	00080023	6068	1000#1101#1111	TEMPERATURE 1	TEMPERATURE 2	TEMPERATURE 3	TEMPERATURE 4	COMPRESSOR 1	COMPRESSOR 2	2025-10-08 13:30:25	SURYA	1012			2025-10-09 00:32:07	SURYA	MAINTENANCE VALUE		2008			0		0	null	null		0	0	0			0	VIKAS																			0	7721928375	20		2025-10-08 13:30:25	2025-10-08 13:30:25	2025-10-08 13:30:25	2025-10-08 13:30:25	2025-10-09 00:32:16	UNDEPLOYED	
  MH18BG8842	MH18BG8842					TALO1	4267	TALOJA PLANT	606724	14660	EVERYWHERE TRANSPORT	UNDEPLOYED		3RD PARTY							30		1047																			14660	EVERYWHERE TRANSPORT	4267		true			NO TRIP > 15 DAYS	1047		CURRENT				606724	TALO1	TALOJA PLANT							2025-08-28 17:57:55	DFPCL_ADMIN	1047			2025-08-31 00:28:50	NA						0		0	null	null		0	0	0			0																				0		30							UNDEPLOYED	
860103061672094	860103061672094	2026-07-02 05:57:24				I008	3694	ZUARI_SPM	4100901165	12194	SRI SATYADEVA TRANSPORT LLP	UNDEPLOYED	0	DEDICATED	404920694679008	893.26m from Ammonia Plant Gudari Gunta Kakinada Urban Kakinada EAST GODAVARI ANDHRA PRADESH INDIA 533003	16.970957	82.271927	0	294	30		1034	NVT3		0		2026-07-02 05:57:24	0	6.01_NT	1.91	0	airtel	1	0	860103061672094	AUTOPLANT			2026-01-21 13:15:28	{"epf": null, "rmc": null, "power": {"mainstatus": "1", "mainvoltage": "0", "batterystatus": null, "batteryvoltage": "4056"}, "idling": {"uid": "bb3aee6a-b6a5-45fb-85a4-7e88df52a82b", "endlat": 16.970957, "endlon": 82.271927, "endtime": 1782971844000, "s...	12194	SRI SATYADEVA TRANSPORT LLP	3694		true	Re-Mapping	Same Device	NO TRIP > 15 DAYS	1034		CURRENT				4100901165	I008	ZUARI_SPM							2026-01-21 13:15:29	HARSH RAGHAV	1034			2026-04-08 00:12:23	NA						0		0	null	null		0	0	0			0																				0		30	2026-07-02 05:57:32	2026-01-21 13:15:28	2026-01-21 13:15:28	2026-01-21 13:15:28	2026-01-21 13:15:28	2026-04-08 00:12:24	UNDEPLOYED	YARDBOUNDARY_250
AP02TA2569	0869925073271551	2026-07-02 05:57:47				1000	3038	KADAPPA	0000901225	7216	SRI LAKSHMI VENKATESWARA TRANSPORT	ACTIVE	0	DEDICATED	0404920694896515	181.35m from Hurlihal Branch Post Office Kudligi  BALLARI KARNATAKA INDIA 583126	14.717841	76.55386	0	283	10		1015	V5		0		2026-07-02 05:57:47				0		1	null	0869925073271551	AUTOPLANT	2026-06-29 14:24:07		2025-12-17 10:54:59	{"epf": null, "rmc": null, "power": {"mainstatus": "1", "mainvoltage": null, "batterystatus": null, "batteryvoltage": null}, "idling": {"uid": "edd9c1f6-7aea-4a65-8b51-3d226da5680d", "endlat": 14.717841, "endlon": 76.55386, "endtime": 1782971867000, "sta...	7216	SRI LAKSHMI VENKATESWARA TRANSPORT	3038	2606290007368	true	New Installation	New Device		NA		CURRENT				0000901225	1000	KADAPPA							2025-12-17 10:54:59	VICAT_KADAPA_SERVICE	1015										0		0	null	null		0	0	0			0																				0		10	2026-07-02 05:58:38	2025-12-17 10:54:59	2025-12-17 10:54:59	2025-12-17 10:54:59	2025-12-17 10:54:59		TOWARDSDESTINATION	YARDBOUNDARY_250
AP02TA6589	0867440061714648						3628	GGU	0002411017	7646	MK ENTERPRISES	UNDEPLOYED		DEDICATED							0		1010															2025-07-24 10:05:19				7646	MK ENTERPRISES	3628		true	Re-Installation	Replacement Device	NO TRIP > 15 DAYS	1010		CURRENT				0002411017	6991	GGU							2024-10-30 10:51:01	NA	1010			2025-11-26 01:54:15	UTCL_SERVICE						0		0	null	null		0	0	0			0																				0		0		2026-06-24 00:14:28				2026-06-24 00:14:28	UNDEPLOYED	
AP02TC6699	0869925073311035	2026-07-02 05:58:14				1000	3038	KADAPPA	0000901225	7216	SRI LAKSHMI VENKATESWARA TRANSPORT	ACTIVE	0	DEDICATED	0404920694896446	2.09kms from Jawahar Higher Primary School Molakalmuru Molakalmuru CHITRADURGA KARNATAKA INDIA 577535	14.714068	76.76581	0	327	10	3718IL TYRE 10.00 R 20: 16 PR	1015	V5		0		2026-07-02 05:58:14				0		1	null	0869925073311035	AUTOPLANT	2026-06-30 11:25:05		2026-01-02 11:09:49	{"epf": null, "rmc": null, "power": {"mainstatus": "1", "mainvoltage": null, "batterystatus": null, "batteryvoltage": null}, "idling": {"uid": "e1843c63-481d-45a2-ac15-0de1baae495a", "endlat": 14.714068, "endlon": 76.76581, "endtime": 1782971894000, "sta...	7216	SRI LAKSHMI VENKATESWARA TRANSPORT	3038	2606300004834	true	Re-Mapping	Same Device	NO TRIP > 15 DAYS	1015		CURRENT		ASHOK LEYLAND LTD	1/2016	0000901225	1000	KADAPPA							2026-01-02 11:09:49	VICAT_KADAPA_SERVICE	1015			2026-04-05 00:12:57	INTEGRATION_SERVICE			1/2016			0		0	null	null		0	0	0			0																				0		10	2026-07-02 05:58:25	2026-01-02 11:09:49	2026-01-02 11:09:49	2026-01-02 11:09:49	2026-01-02 11:09:49	2026-05-10 15:48:43	TOWARDSDESTINATION	YARDBOUNDARY_250
AP02TE5495	862843047226857	2026-06-01 04:35:59					3693	ZUARI_YERRAGUNTLA	4100900998	12135	MARUTHI TRANSPORT	UNDEPLOYED	0	DEDICATED	404920694905263	469.86m from Hindustan Unilever Ltd Lokshahir Anna Bhau Sathe Marg Airoli Thane Navi Mumbai THANE MAHARASHTRA INDIA 400708	19.164984	72.996971	0	240	0		1034	NVT3																	{"epf": null, "power": {"mainstatus": "1", "mainvoltage": "0", "batterystatus": null, "batteryvoltage": "0"}, "idling": {"uid": "b1e0517f-600c-45d9-ab44-bb089a82fb5d", "endlat": 19.164984, "endlon": 72.996971, "endtime": 1780288559000, "startlat": 24.445...	12135	MARUTHI TRANSPORT	3693		true			0	1034		CURRENT				4100900998	0	ZUARI_YERRAGUNTLA	NA	NA	NA	NA	NA	NA	2025-01-10 11:32:56	NA	1034			2025-07-10 20:10:03	NA						0		0	null	null		0	0	0			0																				0		0							UNDEPLOYED	
AP02TH2889	0359688090016311	2026-06-19 10:23:44				S500	3672	ESL STEEL LTD	500499	16036	WEDEL EXPRESS INDIA PRIVATE LIMITED	ACTIVE	1	MARKET	0404920599622673	3.6kms from Sahapur Post Office Purusottampur  GANJAM ODISHA INDIA 761003	19.489613	84.87582	0	241	45		1007	NVT180														2026-06-13 13:31:29		2026-03-31 10:55:12	{"epf": {"uid": "7a39d828-b6bd-4204-ada6-e822cb53c5ea", "endlat": 19.489613, "endlon": 84.87582, "endtime": 1781864624000, "endspeed": 0, "startlat": 19.369867, "startlon": 85.02127, "epfstatus": 1, "noofevent": 161, "starttime": 1781853500000, "startspe...	16036	WEDEL EXPRESS INDIA PRIVATE LIMITED	3672	2606130008090	true	Re-Installation	Replacement Device	NO TRIP > 15 DAYS	1007		CURRENT				500499	S500	ESL STEEL LTD							2026-06-13 15:15:35	VIKASH_UPADHAYAY	1007			2026-06-13 15:15:35	VIKASH_UPADHAYAY						0		0	null	null		0	0	0			0																				0		45		2026-06-29 00:15:10	2026-05-23 14:01:16	2026-06-13 15:15:35	2026-06-13 15:15:35	2026-06-29 00:15:10	TOWARDSDESTINATION	
AP02TH5009	0869925072767195	2026-07-02 05:54:13				1000	3038	KADAPPA	0000901688	14051	CENTRAL WAREHOUSING CORPORATION	UNDEPLOYED	1	DEDICATED	0404920694680180	1.1kms from Mandal Praja Parishad Primary School C Kotha Palli Chennur  Y.S.R. ANDHRA PRADESH INDIA 516162	14.544359	78.763824	0	123	10	ULTRA 1518 T 5L/45WB BS IV	1015	V5		0	0	2026-07-02 05:54:13				1		0	null	0869925072767195	AUTOPLANT	2026-04-05 00:24:50		2025-12-05 06:06:36	{"epf": {"uid": "bc52fdc5-8043-4e31-aab5-79eeb4d3d74d", "endlat": 14.544359, "endlon": 78.763824, "endtime": 1782971653000, "endspeed": 0, "startlat": 14.54436, "startlon": 78.76383, "epfstatus": 1, "noofevent": 10, "starttime": 1782971350000, "startspee...	14051	CENTRAL WAREHOUSING CORPORATION	3038		true	Re-Mapping	Same Device	NO TRIP > 15 DAYS	1015		CURRENT		TATA MOTORS LTD	12/2018	0000901688	1000	KADAPPA							2025-12-05 06:06:37	VICAT_KADAPA_SERVICE	1015			2026-02-20 00:20:28	INTEGRATION_SERVICE			12/2018			0		0	null	null		0	0	0			0																				0		10	2026-07-02 05:55:44	2025-12-05 06:06:36	2025-12-05 06:06:36	2025-12-05 06:06:36	2025-12-05 06:06:36	2026-04-21 00:14:07	UNDEPLOYED	YARDBOUNDARY_250
AP02TH5569	862843049369226	2026-07-02 02:58:59					3693	ZUARI_YERRAGUNTLA	NA	12228	JMS TRANSPORTER	UNDEPLOYED	0	DEDICATED	404920394666399	1.02kms from Sri Venkatarama Swamy Borewell Gowrava Gardens Main Road Santhi Nagar Indira Gandhi Nagar Anantapur Anantapur ANANTAPUR ANDHRA PRADESH INDIA 515004	14.704244	77.593735	0	238	0		1034	NVT3		0		2026-07-02 02:58:59	0	6.01_NT	1.81	0	airtel	1	0	862843049369226	AUTOPLANT	2025-02-18 12:39:00			{"epf": null, "rmc": null, "power": {"mainstatus": "1", "mainvoltage": "0", "batterystatus": null, "batteryvoltage": "4117"}, "idling": null, "sensor": {"type": ["temp", "door", "comp", "fuel"], "vbstatus": null, "digitalio": null, "compressor": "off", "...	12135	MARUTHI TRANSPORT	3693		true	Re-Mapping	Same Device	NO TRIP > 15 DAYS	1034		CURRENT				4100900998	0	ZUARI_YERRAGUNTLA	NA	NA	NA	NA	NA	NA	2025-01-10 11:32:35	NA	1034			2025-11-23 03:05:08	NA						0		0	null	null		0	0	0			0																				0		0	2026-07-02 02:59:25					2025-11-23 03:05:18	UNDEPLOYED	YARDBOUNDARY_250
AP02X8378	862843043299536	2026-07-02 05:57:58					3692	HCIL_AMMA	4100901058	12113	NATIONAL ROADWAYS	UNDEPLOYED	0	DEDICATED	404920694903916	39.93m from Shiv Om Industries Parsakhera Industrial Area Bareilly Parsakhera Industrial Area BAREILLY UTTAR PRADESH INDIA 243502	28.42959	79.357826	0	143	0		1034	NVT3		0		2026-07-02 05:57:58	0	6.01_CC	1.82	0	airtel	1	0	862843043299536	AUTOPLANT				{"epf": null, "rmc": null, "power": {"mainstatus": "1", "mainvoltage": "25115", "batterystatus": null, "batteryvoltage": "0"}, "idling": {"uid": "75c034b1-49d3-4656-8221-85fc7c4c9255", "endlat": 28.42959, "endlon": 79.357826, "endtime": 1782971878000, "s...	12113	NATIONAL ROADLINES	3692		true			0	1034		CURRENT				4100901058	0	HCIL_AMMA	NA	NA	NA	NA	NA	NA	2025-01-10 11:33:13	NA	1034			2025-07-10 20:10:03	NA						0		0	null	null		0	0	0			0																				0		0	2026-07-02 05:58:34						UNDEPLOYED	YARDBOUNDARY_250
AP03TA3627	0869925073687863	2026-06-20 08:42:03				1000	3038	KADAPPA	0000901457	16006	S R LOGISTICS	ACTIVE	0	DEDICATED	0404920694898262	1.08kms from Nadimpalli Sub Health Centre Nadimpalli Proddatur Proddatur Y.S.R. ANDHRA PRADESH INDIA 516360	14.738202	78.54702	23	98	10	LPT 3118 TC BSIII (8X2)(COWL)	1015	V5		0		2026-06-20 08:42:03				0		1	null	0869925073687863	AUTOPLANT	2026-07-01 13:52:05		2026-02-26 09:45:04	{"epf": null, "rmc": null, "power": {"mainstatus": "1", "mainvoltage": null, "batterystatus": null, "batteryvoltage": null}, "idling": null, "sensor": {"type": ["temp", "door", "comp", "fuel"], "vbstatus": null, "digitalio": null, "compressor": null, "do...	15987	SR LOGISTICS	3038	2607010006341	true	New Installation	New Device		1015		CURRENT		TATA MOTORS LTD	1/2011	901457	1000	KADAPPA							2026-02-26 09:45:06	VICAT_KADAPA_SERVICE	1015			2026-02-26 11:17:11	INTEGRATION_SERVICE			1/2011			0		0	null	null		0	0	0			0																				0		10	2026-07-01 13:58:37	2026-02-26 09:45:04	2026-02-26 09:45:04	2026-02-26 09:45:04	2026-02-26 09:45:04	2026-04-06 15:18:42	SCHEDULED	YARDBOUNDARY_250
AP03TC0959	AP03TC0959	2026-07-02 05:57:25					3127	KESORAM WORKS	S07862	12042	SKLS LORRY SERVICESS	DEPLOYED	0	3RD PARTY		121.67m from KGS Auto Garage Madina Nagar Konavattam Vellore Vellore VELLORE TAMIL NADU INDIA 632013	12.9239583333333	79.1111979166667	0	91	12	TRUCK	1009	VENDOR_GPS	WHEELSEYE	0		2026-07-02 05:57:25	OFF			0		ON	null	867857037177750	WheelEye	2025-02-14 13:48:28			{"epf": null, "rmc": null, "power": {"mainstatus": "ON", "mainvoltage": null, "batterystatus": null, "batteryvoltage": "0.0"}, "idling": {"uid": "3ae79a80-570a-4d3e-b5cf-3bad7ba849da", "endlat": 12.9239583333333, "endlon": 79.1111979166667, "endtime": 17...	7158	VAISHNAVI TRANSPORT CORPORATION	3027		true			0	1009		CURRENT		TATA	2002	V01018	0	SDM-201	NA	NA	NA	NA	NA	NA	2024-03-19 05:44:13	NA	1009			2025-07-10 19:50:45	NA			2002			0		0	null	null		0	0	0			0																				0		12	2026-07-02 05:57:46						EMPTY	YARDBOUNDARY_250
AP03TE9892	0359688090237743	2026-07-02 05:56:03				I007	3693	ZUARI_YERRAGUNTLA	NA	12228	JMS TRANSPORTER	UNDEPLOYED	0	DEDICATED	0404920394520145	1.42kms from Pedi A Nap Adi Post Office Yerraguntla  Y.S.R. ANDHRA PRADESH INDIA 516309	14.600653	78.520515	0	45	0		1034	NVT180		0		2026-07-02 05:56:03				0		1	null	0359688090237743	AUTOPLANT	2025-12-09 23:01:00			{"epf": null, "rmc": null, "power": {"mainstatus": "1", "mainvoltage": null, "batterystatus": null, "batteryvoltage": null}, "idling": {"uid": "22ef8e60-8f7c-4ef0-b7e7-ea0dabc8ae0e", "endlat": 14.600653, "endlon": 78.520515, "endtime": 1782971763000, "st...	12133	AMMAYAPPER ROADWAYS	3693		true	Re-Mapping	Same Device	NO TRIP > 15 DAYS	1034		CURRENT				4100900977	0	ZUARI_YERRAGUNTLA	NA	NA	NA	NA	NA	NA	2025-01-10 11:32:52	NA	1034			2025-11-15 11:22:48	NA						0		0	null	null		0	0	0			0																				0		0	2026-07-02 05:56:11					2025-12-25 00:16:03	UNDEPLOYED	YARDBOUNDARY_250
AP03TE9893	0359688090243048	2025-03-02 15:31:39					3693	ZUARI_YERRAGUNTLA	4100900977	12133	AMMAYAPPER ROADWAYS PRIVATE LIMITED	UNDEPLOYED	1	DEDICATED	0404920595151276	1.46kms from T Sadipirala Bus Stop NH 716 Kamalapuram  Y.S.R. ANDHRA PRADESH INDIA 516289	14.592484	78.62533	0	34	0		1034																			12133	AMMAYAPPER ROADWAYS	3693		true			0	1034		CURRENT				4100900977	0	ZUARI_YERRAGUNTLA	NA	NA	NA	NA	NA	NA	2025-01-10 11:33:01	NA	1034			2025-07-10 20:10:03	NA						0		0	null	null		0	0	0			0																				0		0							UNDEPLOYED	
AP03TE9894	862843049354491	2026-07-02 05:57:06				I007	3693	ZUARI_YERRAGUNTLA	NA	12228	JMS TRANSPORTER	UNDEPLOYED	0	DEDICATED	404920394523726	1.51kms from Pedi A Nap Adi Post Office Yerraguntla  Y.S.R. ANDHRA PRADESH INDIA 516309	14.60148	78.521515	0	62	0		1034	NVT3		78		2026-07-02 05:57:06	0	6.01_NT	1.81	0	airtel	1	0	862843049354491	AUTOPLANT	2025-12-08 11:02:00			{"epf": null, "rmc": null, "power": {"mainstatus": "1", "mainvoltage": "0", "batterystatus": null, "batteryvoltage": "4040"}, "idling": {"uid": "4b82f8e7-b4d6-4a8a-b71a-e87afc7a7e3f", "endlat": 14.60148, "endlon": 78.521515, "endtime": 1782971826000, "st...	12133	AMMAYAPPER ROADWAYS	3693		true	Re-Mapping	Same Device	NO TRIP > 15 DAYS	1034		CURRENT				4100900977	0	ZUARI_YERRAGUNTLA	NA	NA	NA	NA	NA	NA	2025-01-10 11:32:18	NA	1034			2025-11-13 05:48:24	NA						0		0	null	null		0	0	0			0																				0		0	2026-07-02 05:57:37					2025-12-24 00:19:23	UNDEPLOYED	SOURCE
AP03TE9895	0359688090249904	2026-07-02 05:56:58				I007	3693	ZUARI_YERRAGUNTLA	NA	12228	JMS TRANSPORTER	UNDEPLOYED	0	DEDICATED	0404920393173432	1.47kms from T Sadipirala Bus Stop NH 716 Kamalapuram  Y.S.R. ANDHRA PRADESH INDIA 516289	14.593302	78.62551	0	109	0		1034	NVT180		0		2026-07-02 05:56:58				0		1	null	0359688090249904	AUTOPLANT	2025-12-10 03:09:00			{"epf": null, "rmc": null, "power": {"mainstatus": "1", "mainvoltage": null, "batterystatus": null, "batteryvoltage": null}, "idling": {"uid": "7f35e928-cb6b-49cb-b6c6-aea1bae2d31b", "endlat": 14.593302, "endlon": 78.62551, "endtime": 1782971818000, "sta...	12133	AMMAYAPPER ROADWAYS	3693		true	Re-Mapping	Same Device	NO TRIP > 15 DAYS	1034		CURRENT				4100900977	0	ZUARI_YERRAGUNTLA	NA	NA	NA	NA	NA	NA	2025-01-10 11:32:05	NA	1034			2025-11-15 11:23:56	NA						0		0	null	null		0	0	0			0																				0		0	2026-07-02 05:57:20					2025-12-26 00:33:11	UNDEPLOYED	YARDBOUNDARY_250
AP03TE9901	0359688090241505	2026-05-08 12:36:37					3693	ZUARI_YERRAGUNTLA	NA	12228	JMS TRANSPORTER	UNDEPLOYED	1	DEDICATED	0404920595153804	950.81m from 12 Block F VGN Temple Town Karpagambal Nagar Tiruverkadu Avadi Chennai THIRUVALLUR TAMIL NADU INDIA 600077	13.068573	80.11241	0	114	0		1034	NVT180														2025-02-27 06:42:00			{"epf": {"uid": "2693bd51-e83f-4f84-8845-763a4735fab4", "endlat": 13.068573, "endlon": 80.11241, "endtime": 1778243797000, "endspeed": 0, "startlat": 13.068573, "startlon": 80.11241, "epfstatus": 1, "noofevent": 60, "starttime": 1778243368000, "startspee...	12133	AMMAYAPPER ROADWAYS	3693		true	Re-Mapping	Same Device	NO TRIP > 15 DAYS	1034		CURRENT				4100900977	0	ZUARI_YERRAGUNTLA	NA	NA	NA	NA	NA	NA	2025-01-10 11:31:52	NA	1034			2025-10-08 00:33:48	NA						0		0	null	null		0	0	0			0																				0		0						2025-10-08 00:33:57	UNDEPLOYED	
AP03TE9902	0359688090244467	2026-07-02 05:57:28				I007	3693	ZUARI_YERRAGUNTLA	NA	12228	JMS TRANSPORTER	UNDEPLOYED	0	DEDICATED	0404920394431437	105.66m from Bhagwan Grand Veg Chikka Ballapur Bypass Chikkaballapura  CHIKKAMAGALURU KARNATAKA INDIA 562101	13.451785	77.737335	0	198	0		1034	NVT180		0	1	2026-07-02 05:57:28				0		1	null	0359688090244467	AUTOPLANT	2025-12-05 17:10:00			{"epf": null, "rmc": null, "power": {"mainstatus": "1", "mainvoltage": null, "batterystatus": "1", "batteryvoltage": "06"}, "idling": {"uid": "a0476db4-d257-455f-9a0d-d17d82dd8c61", "endlat": 13.451785, "endlon": 77.737335, "endtime": 1782971848000, "sta...	12133	AMMAYAPPER ROADWAYS	3693		true	Re-Mapping	Same Device	NO TRIP > 15 DAYS	1034		CURRENT				4100900977	0	ZUARI_YERRAGUNTLA	NA	NA	NA	NA	NA	NA	2025-01-10 11:32:50	NA	1034			2025-12-01 02:59:53	INTEGRATION_SERVICE						0		0	null	null		0	0	0			0																				0		0	2026-07-02 05:57:50					2025-12-21 00:19:17	UNDEPLOYED	YARDBOUNDARY_250
AP03TE9904	862843049386436	2026-07-02 05:56:18				I007	3693	ZUARI_YERRAGUNTLA	NA	12228	JMS TRANSPORTER	UNDEPLOYED	0	DEDICATED	404920394666616	718.77m from Manju Lodge NH 44 Bagepalli  CHIKKAMAGALURU KARNATAKA INDIA 561207	13.783844	77.774567	0	318	0		1034	NVT3		0		2026-07-02 05:56:18	0	6.01_NT	1.81	0	airtel	1	0	862843049386436	AUTOPLANT	2025-12-05 22:39:00			{"epf": null, "rmc": null, "power": {"mainstatus": "1", "mainvoltage": "0", "batterystatus": null, "batteryvoltage": "4005"}, "idling": {"uid": "e4d13590-60fa-445b-93f9-16bcd487d669", "endlat": 13.783844, "endlon": 77.774567, "endtime": 1782971778000, "s...	12133	AMMAYAPPER ROADWAYS	3693		true	Re-Mapping	Same Device	NO TRIP > 15 DAYS	1034		CURRENT				4100900977	0	ZUARI_YERRAGUNTLA	NA	NA	NA	NA	NA	NA	2025-01-10 11:32:00	NA	1034			2025-11-15 11:27:43	INTEGRATION_SERVICE						0		0	null	null		0	0	0			0																				0		0	2026-07-02 05:56:49					2025-12-21 00:19:18	UNDEPLOYED	YARDBOUNDARY_250

--------

SELECT *
FROM ap_masters.mst_plant
LIMIT 20;







4160					india							1010	UTCL	2025-03-06 12:29:34										 	india		DEPOT_CBT						0						india							INACTIVE			0		4160	DEPOT_CBT	 
4561							987654432	BG_Infra@gmail.com	BG Infra			1063	BG Infra	2026-02-16 06:19:44	bginfra_impl									0001			Zuari						5834	Maharashtra												ACTIVE			2186	West	4460	Zuari	Zuari
4575							9099999999	GGVL@gmail.com	GGVL			1070	GRPL Roadways	2026-02-18 12:21:16	grpl_roadways_admin									0001			GGVL						6071	Madhya Pradesh												ACTIVE			2215	North	4575	GGVL	0001
4468							123456789	test@gmail.com	Rahul Joshi			1065	Gallantt	2025-11-24 13:13:12	gallantt_admin									001			Gallantt Ispat						5888	Uttar Pradesh												ACTIVE	gallantt_admin	2025-11-24 13:33:26	2192	North	4468	Gallantt	001
4534							9234685935	bokaro@ots.co.in	GB_BOKARO			1069	GB Transport	2026-02-04 11:44:43	gbtrans_admin									001			BOKARO STEEL PLANT		bokaro@ots.co.in	GB_BOKARO			6046	Jharkhand												ACTIVE	gbtrans_admin	2026-02-13 12:53:12	2210	North	4534	Bokaro	001
4276												1047	DFPCL	2025-06-05 17:43:45	INTEGRATION_SERVICE									002			Home						0													INACTIVE			0		4276	Home	002
4535							8455077295	rourkela@ots.co.in	GB_ROURKELA			1069	GB Transport	2026-02-04 11:46:17	gbtrans_admin									002			ROURKELA STEEL PLANT		rourkela@ots.co.in	GB_ROURKELA			6051	Odisha												ACTIVE	gbtrans_admin	2026-02-10 11:54:41	2211	East	4535	Rourkela	002
4536							9883353637	durgapur@ots.co.in	GB_DURGAPUR			1069	GB Transport	2026-02-04 11:47:38	gbtrans_admin									003			DURGAPUR STEEL PLANT		durgapur@ots.co.in	GB_DURGAPUR			6054	West Bengal												ACTIVE	gbtrans_admin	2026-02-10 11:32:47	2211	East	4536	Durgapur	003
4290					india							1014	JSW Cement	2025-06-11 13:09:44										09977			JKPlant_Test						0	NA					india							ACTIVE			0	NA	4290	JKPlant_Test	09977
3038							0				0	1015	NA	2022-12-09 09:28:00	NA									1000			Kadappa	0				0	71	NA							0				0	ACTIVE	NA	2024-12-09 12:45:00	2039	NA	3038	Kadappa	1000
4494							1234545555	xyz@gmail.com	xyz			1062	Vicat Inbound	2026-01-15 06:42:20	vicat_in_impadmin									1000			Bharathi Cement Corpn P Ltd						5802	Andhra Pradesh												ACTIVE			2183	South	4494	Bharathi Cement Corpn P Ltd	1000
30647							9765678976	Kolkata24243@GMAIL.COM	Kolkata			1069	GB Transport	2026-03-16 08:02:36	gbtrans_admin									100001			Sail Dankuni Warehouse						6054	West Bengal												ACTIVE			2211	East	30647	Sail Dankuni Warehouse	100001
4254												1045		2025-05-23 10:12:09										1001			Noida						4155													ACTIVE			2066		4254	Noida	1001
4357							9876543210	test1001@gmail.com	test 1001			1049	Testing Company	2025-07-31 11:07:47	nikhil_test1									1001			test plant 1001						4362	Maharashtra												ACTIVE			2097	West	4357	master test plant 1001	9001
30918	MBP, B1, Sec-1, A-1604, Rupa Solitaire, Millennium Business park,  Mahape, Navi Mumbai, Thane, Maharashtra, 400701	MBP, B1, Sec-1, A-1604, Rupa Solitaire, Millennium Business park,  Mahape, Navi Mumbai, Thane, Maharashtra, 400701	MBP, B1, Sec-1, A-1604, Rupa Solitaire, Millennium Business park,  Mahape, Navi Mumbai, Thane, Maharashtra, 400701	Mumbai	India	Mumbai	9834567822	rutvik.panchal@autoplant.in	rutvik.panchal@autoplant.in	Maharashtra	401202	1079	Adani RMC	2026-06-15 08:07:35	adanirmc_admin									1001			Sahar Plant						6375	Maharashtra	MBP, B1, Sec-1, A-1604, Rupa Solitaire, Millennium Business park,  Mahape, Navi Mumbai, Thane, Maharashtra, 400701	MBP, B1, Sec-1, A-1604, Rupa Solitaire, Millennium Business park,  Mahape, Navi Mumbai, Thane, Maharashtra, 400701	MBP, B1, Sec-1, A-1604, Rupa Solitaire, Millennium Business park,  Mahape, Navi Mumbai, Thane, Maharashtra, 400701				9834567822	rutvik.panchal@autoplant.in	rutvik.panchal@autoplant.in		401202	ACTIVE			2250	West	30918	Sahar Plant	1102
30772							9898898900	BPCL@gmail.com	BPCL			1029	Deepak Fertilizer	2026-04-09 11:19:14	deepak_impadmin									100182			BPCL 						5767	Maharashtra Region												ACTIVE			2174	West Zone	30772	BPCL	100182
3030							0				0	1012		2024-10-22 10:00:00										1002	india		SCL_Ranavav	0				0	0								0				0	ACTIVE			2034		3030	SCL_Ranavav	1002
3675							0				0	1000		2024-12-05 08:58:53										1002	india		SCL_Ranavav	0				0	0								0				0	INACTIVE		2024-12-05 09:11:28	2034		3675	SCL_Ranavav	1002
4255												1045		2025-05-23 10:14:13										1002			VADILAL GHAZIABAD						4155													ACTIVE			2066		4255	VADILAL GHAZIABAD	1002


----

SELECT DATABASE(); ->
ap_widgets



DESCRIBE tb_vehiclemaster;->
vehicle_no	varchar(255)	NO	PRI		
device_id	varchar(255)	YES	MUL		
latest_gps_datetime	datetime	YES			
nearest_source_distance	varchar(255)	YES			
nearest_source_id	varchar(255)	YES			
nearest_source_position	varchar(255)	YES			
plant_code	varchar(255)	YES			
plant_id	varchar(255)	YES	MUL		
plant_name	varchar(255)	YES			
transporter_code	varchar(255)	YES	MUL		
transporter_id	varchar(255)	YES			
transporter_name	varchar(255)	YES			
vehicle_deployment_status	varchar(255)	YES			
vehicle_power_status	varchar(255)	YES			
vehicle_type	varchar(255)	YES			
IMSI_NO	varchar(255)	YES			
current_location	longtext	YES			
latitude	double	YES			
longitude	double	YES			
speed	double	YES			
course	bigint	YES			
max_carrying_capacity	bigint	YES			
vehicle_model	varchar(50)	YES			
hierarchy_path	varchar(10)	YES			
DEVICE_TYPE	varchar(50)	YES			
VENDOR	varchar(255)	YES			
DISTANCE	double	YES			
BATTERY_STATUS	varchar(50)	YES			
SIGNAL_RECEIVED_TIME	timestamp	YES			
IGNITION_STATUS	varchar(50)	YES			
HW_VERSION	varchar(250)	YES			
SW_VERSION	varchar(250)	YES			
EPF_STATUS	varchar(50)	YES			
SIM_VENDOR	varchar(100)	YES			
MAIN_STATUS	varchar(100)	YES			
PACKET_STATUS	varchar(100)	YES			
VIEW_DEVICE_ID	varchar(100)	YES			
VENDOR_NAME	varchar(250)	YES			
TRIP_CREATION_DATETIME	timestamp	YES			
reruncompanyid	varchar(30)	YES			
device_installation_date	timestamp	YES			
gpssignal	json	YES			
billing_transporter_id	varchar(255)	YES			
billing_trans_name	varchar(255)	YES			
billing_plant_id	varchar(255)	YES			
active_trip_id	varchar(50)	YES			
VEHICLE_STATUS	varchar(50)	YES			
INSTALLATION_REMARK	varchar(255)	YES			
INSTALLATION_SUBREMARK	varchar(255)	YES			
REASON_CODE	varchar(100)	YES			
LATEST_INSTALLATION_COMPANYID	varchar(10)	YES			
REMARKS	varchar(255)	YES			
VEHICLE_DATA_SOURCE	varchar(100)	YES			
INSURANCE_EXPIRY_DATE	datetime	YES			
VEHICLE_MAKE	varchar(100)	YES			
VEHICLE_YOM	varchar(10)	YES			
BILLING_TRANSPORTER_CODE	varchar(100)	YES			
BILLING_PLANT_CODE	varchar(100)	YES			
BILLING_PLANT_NAME	varchar(255)	YES			
ANALOG1	varchar(255)	YES			
ANALOG2	varchar(255)	YES			
ANALOG3	varchar(255)	YES			
ANALOG4	varchar(255)	YES			
DIGITAL1	varchar(50)	YES			
DIGITAL2	varchar(50)	YES			
FIRST_INSTALLED_DATE_TIME	datetime	YES			
FIRST_INSTALLED_BY	varchar(100)	YES			
FIRST_INSTALLED_COMPANY_ID	varchar(10)	YES			
DEVICE_REMOVED_DATE_TIME	datetime	YES			
DEVICE_REMOVED_BY	varchar(100)	YES			
LATEST_INSTALLATION_DATE_TIME	datetime	YES			
LATEST_INSTALLED_BY	varchar(100)	YES			
MAINTENANCE	varchar(255)	YES			
VEHICLE_MODEL_NO	varchar(100)	YES			
VEH_MANUFACTURED_YEAR	varchar(10)	YES			
VEHICLE_BODY_TYPE	varchar(100)	YES			
VEHICLE_FLOOR_TYPE	varchar(100)	YES			
NO_OF_WHEELS	int	YES			
FUEL_TYPE	varchar(50)	YES			
OPTIMAL_CARRY_CAPACITY	bigint	YES			
GROSS_WEIGHT	varchar(50)	YES			
UNLADEN_WEIGHT	varchar(50)	YES			
VEHICLE_ORIGIN	varchar(100)	YES			
VEHICLE_LENGTH	decimal(10,0)	YES			
VEHICLE_HEIGHT	decimal(10,0)	YES			
VEHICLE_WIDTH	decimal(10,0)	YES			
ENGINE_NO	varchar(100)	YES			
CHASSIS_NO	varchar(100)	YES			
DRIVER_ID	bigint	YES			
DRIVERNAME	varchar(100)	YES			
PRIMARY_OWNER_NAME	varchar(100)	YES			
PRIMARY_OWNER_MOBILE_NO	varchar(15)	YES			
SECONDARY_OWNER_NAME	varchar(100)	YES			
SECONDARY_OWNER_MOBILE_NO	varchar(15)	YES			
VEHICLE_RC_NO	varchar(100)	YES			
INSURANCE_NO	varchar(100)	YES			
INSURANCE_COMPANY_NAME	varchar(255)	YES			
ROAD_TAX_RENEWAL_DT	datetime	YES			
FITNESS_RENEWAL_DT	datetime	YES			
GOODS_PERMIT_VALIDITY_DT	datetime	YES			
HAZARDOUS_MATERIAL_LICENSE	varchar(100)	YES			
PVC_ISSUED_DT	datetime	YES			
PVC_VALIDITY_DT	datetime	YES			
PUC_ISSUED_DT	datetime	YES			
PUC_VALIDITY_DT	datetime	YES			
PREFERED_DESTINATION	varchar(255)	YES			
CREATED_DT	datetime	YES			
MODIFIED_DT	datetime	YES			
MODIFIED_BY	varchar(255)	YES			
DRIVER_PHONE_NUMBER	varchar(15)	YES			
MAX_CARRY_CAPACITY	bigint	YES			
insertion_datetime	timestamp	YES		CURRENT_TIMESTAMP	DEFAULT_GENERATED on update CURRENT_TIMESTAMP
DEVICE_LATEST_INSTALLATION_DATE	timestamp	YES			
VEHICLE_MAPPING_DATE	timestamp	YES			
VEHICLE_LATEST_MAPPING_DATE	timestamp	YES			
RECORD_CREATED_DATE	timestamp	YES			
RECORD_UPDATED_DATE	timestamp	YES			
vehicle_location_status	varchar(20)	YES			
detention_type	varchar(30)	YES	

------


plant_id	int	NO	PRI		
billing_spoc_addressline1	varchar(500)	YES			
billing_spoc_addressline2	varchar(500)	YES			
billing_spoc_addressline3	varchar(500)	YES			
billing_city	varchar(60)	YES			
billing_country	varchar(40)	YES			
billing_district	varchar(40)	YES			
billing_spoc_contact	varchar(10)	YES			
billing_spoc_email	varchar(50)	YES			
billing_spoc_name	varchar(40)	YES			
billing_state	varchar(25)	YES			
billing_zipcode	varchar(25)	YES			
company_id	int	NO			
company_name	varchar(100)	NO			
created_date_time	datetime	NO			
created_by	varchar(40)	NO			
inbound_prefix	varchar(30)	YES			
manufacturing_code	varchar(255)	YES			
manufacturing_name	varchar(40)	YES			
outbound_prefix	varchar(30)	YES			
plant_address_line1	varchar(500)	YES			
plant_address_line2	varchar(500)	YES			
plant_address_line3	varchar(500)	YES			
plant_city	varchar(40)	YES			
plant_code	varchar(255)	NO	PRI		
plant_country	varchar(30)	YES			
plant_district	varchar(40)	YES			
plant_name	varchar(100)	NO			
plant_spoc_contact	varchar(10)	YES			
plant_spoc_email	varchar(50)	YES			
plant_spoc_name	varchar(40)	YES			
plant_state	varchar(25)	YES			
plant_zipcode	varchar(25)	YES			
region_id	int	NO			
region_name	varchar(100)	NO			
rl_address_line1	varchar(500)	YES			
rl_address_line2	varchar(500)	YES			
rl_address_line3	varchar(500)	YES			
rl_city	varchar(60)	YES			
rl_country	varchar(30)	YES			
rl_district	varchar(60)	YES			
rl_spoc_contact	varchar(40)	YES			
rl_spoc_email	varchar(50)	YES			
rl_spoc_name	varchar(40)	YES			
rl_state	varchar(40)	YES			
rl_zipcode	varchar(25)	YES			
status	varchar(8)	NO			
updated_by	varchar(40)	YES			
updated_date_time	datetime	YES			
zone_id	int	NO			
zone_name	varchar(100)	NO			
master_plant_id	int	YES			
master_plant_name	varchar(255)	YES			
master_plant_code	varchar(100)	YES												


================


ap_master:
alertprocess_seq
company
mst_company
mst_driverphone
mst_driverphone_aud
mst_plant
mst_region
mst_secondaryclient
mst_secondaryclient_aud
mst_secondaryclientcontact
mst_secondaryclientcontact_aud
mst_telenitytoken
mst_transporter
mst_transporter_log
mst_vehicle
mst_vehicle_log
mst_vehicle_log_archival
mst_zone
order_response_history
plant
qrtz_blob_triggers
qrtz_calendars
qrtz_cron_triggers
qrtz_fired_triggers
qrtz_job_details
qrtz_locks
qrtz_paused_trigger_grps
qrtz_scheduler_state
qrtz_simple_triggers
qrtz_simprop_triggers
qrtz_triggers
region
reverse_logistic_data
revinfo
seq
seq_transporterlog
seq_vehiclelog
tb_bulkuploadjob
tb_defaultchoosecolumn
tb_defaultchoosecolumn_aud
transporter
violationconfig_seq
violationdata_seqalertprocess_seq
company
mst_company
mst_driverphone
mst_driverphone_aud
mst_plant
mst_region
mst_secondaryclient
mst_secondaryclient_aud
mst_secondaryclientcontact
mst_secondaryclientcontact_aud
mst_telenitytoken
mst_transporter
mst_transporter_log
mst_vehicle
mst_vehicle_log
mst_vehicle_log_archival
mst_zone
order_response_history
plant
qrtz_blob_triggers
qrtz_calendars
qrtz_cron_triggers
qrtz_fired_triggers
qrtz_job_details
qrtz_locks
qrtz_paused_trigger_grps
qrtz_scheduler_state
qrtz_simple_triggers
qrtz_simprop_triggers
qrtz_triggers
region
reverse_logistic_data
revinfo
seq
seq_transporterlog
seq_vehiclelog
tb_bulkuploadjob
tb_defaultchoosecolumn
tb_defaultchoosecolumn_aud
transporter
violationconfig_seq
violationdata_seq



======
SELECT *
FROM ap_masters.mst_company
LIMIT 20;

1000	NA							NA								Autoplant System India Pvt Ltd	NA		2020-04-02 14:00:01										NA		NA	NA	NA	NA	ACTIVE					DISABLED
1001	NA	MBP 1	MBP 2	MBP 3	Navi Mumbai	India	Thane	NA	9665280836	prismmines1@test.com	Vidhyanshu	Maharashtra	400701			Prism Mines	Shipper		2020-04-02 14:00:02	MBP 1	MBP 2	MBP 3	Navi Mumbai	India	Thane	Maharashtra	400701		Mines	2025-08-13	NA	9665280843	prismmines1@test.com	Vidhyanshu	ACTIVE		2025-08-13 09:31:44			DISABLED
1002	NA	MBP 1	MBP 2	MBP 3	Navi Mumbai	India	Thane	NA	9665280836	tcifreight1@test.com	Sohil	Maharashtra	400701			TCI FREIGHT	Transporter		2020-04-15 04:45:52	MBP 1	MBP 2	MBP 3	Navi Mumbai	India	Thane	Maharashtra	400701		3PL	2025-08-13	NA	9665280843	tcifreight1@test.com	Sohil	ACTIVE		2025-08-13 10:14:36			DISABLED
1003	NA							NA								Coke	NA		2020-04-15 04:46:41										NA		NA	NA	NA	NA	INACTIVE					DISABLED
1004	NA							NA								Nuvista	NA		2020-09-21 08:43:38										NA		NA	NA	NA	NA	ACTIVE			Nuvista		DISABLED
1005	NA							NA								NuVista	NA		2021-10-25 09:20:25										NA		NA	NA	NA	NA	INACTIVE					DISABLED
1006	NA							NA								Wonder Cements	NA		2021-10-25 09:20:25										NA		NA	NA	NA	NA	INACTIVE					DISABLED
1007	NA							NA								Vedanta - ESL	NA		2021-10-25 09:21:04										NA		NA	NA	NA	NA	ACTIVE			ESL		DISABLED
1009	NA							NA								Vasavadatta	NA		2022-05-27 07:32:49										NA		NA	NA	NA	NA	ACTIVE			Kesoram		DISABLED
1010	NA							NA								UTCL	NA		2022-05-27 07:32:49										NA		NA	NA	NA	NA	ACTIVE			UTCL		DISABLED
1012	NA							NA								SAURASHTRA CEMENT	NA		2022-10-19 10:30:14										NA		NA	NA	NA	NA	ACTIVE		2026-06-09 16:35:47	SCL	ENABLED	DISABLED
1013	NA							NA								AutoNovire	NA		2023-03-09 09:42:54										NA		NA	NA	NA	NA	INACTIVE					DISABLED
1014	NA							NA								JSW Cement	NA		2022-11-29 12:31:47										NA		NA	NA	NA	NA	ACTIVE			JSW		DISABLED
1015	NA							NA								Vicat Cement	NA		2022-12-09 09:13:54										NA		NA	NA	NA	NA	ACTIVE			Vicat		DISABLED
1016	NA							NA								Prism Cement	NA		2023-02-09 10:48:02										NA		NA	NA	NA	NA	ACTIVE					DISABLED
1017	NA							NA								STAR CEMENT	NA		2023-02-03 10:31:21										NA		NA	NA	NA	NA	ACTIVE			StarCement		DISABLED
1018	NA							NA								Coldrush Logistics	NA		2023-05-03 16:00:00										NA		NA	NA	NA	NA	ACTIVE					DISABLED
1019	NA							NA								AVG Logistics	NA		2023-05-04 16:00:00										NA		NA	NA	NA	NA	ACTIVE					DISABLED
1020	NA							NA								Creambell	NA		2023-06-17 06:18:38										NA		NA	NA	NA	NA	ACTIVE			CREAMBELL		DISABLED
1025	NA							NA								Parag	NA		2023-11-16 07:37:10										NA		NA	NA	NA	NA	ACTIVE					DISABLED
----


DESCRIBE ap_masters.mst_company;

company_id	int	NO	PRI		
bill_frequency	varchar(10)	NO			
billing_address_line1	varchar(500)	YES			
billing_address_line2	varchar(500)	YES			
billing_address_line3	varchar(500)	YES			
billing_city	varchar(40)	YES			
billing_country	varchar(15)	YES			
billing_district	varchar(30)	YES			
billing_option	varchar(15)	NO			
billing_spoc_contactnumber	varchar(10)	YES			
billing_spoc_email	varchar(50)	YES			
billing_spoc_name	varchar(50)	YES			
billing_state	varchar(20)	YES			
billing_zipcode	varchar(6)	YES			
company_logo1	varchar(255)	YES			
company_logo2	varchar(255)	YES			
company_name	varchar(60)	NO			
company_type	varchar(15)	NO			
created_by	varchar(20)	YES			
created_datetime	datetime	YES			
ho_addressline1	varchar(500)	YES			
ho_addressline2	varchar(500)	YES			
ho_addressline3	varchar(500)	YES			
ho_city	varchar(40)	YES			
ho_country	varchar(15)	YES			
ho_district	varchar(30)	YES			
ho_state	varchar(20)	YES			
ho_zipcode	varchar(6)	YES			
icon	varchar(255)	YES			
industry	varchar(15)	NO			
onboarded_date	varchar(255)	YES			
pricing_type	varchar(10)	NO			
spoc_contactnumber	varchar(10)	NO			
spoc_email	varchar(50)	NO			
spoc_name	varchar(50)	NO			
status	varchar(10)	NO			
updated_by	varchar(20)	YES			
updated_datetime	datetime	YES			
bi_company_name	varchar(50)	YES			
epod_access	varchar(20)	YES			
driver_user_creation	varchar(20)	YES		DISABLED	
												---
DESCRIBE ap_masters.mst_zone;						zone_id	int	NO	PRI	
company_id	int	NO		
company_name	varchar(60)	YES		
created_by	varchar(20)	NO		
created_datetime	datetime	NO		
status	varchar(10)	NO		
updated_by	varchar(20)	YES		
updated_datetime	datetime	YES		
zone_address_line1	varchar(500)	YES		
zone_address_line2	varchar(500)	YES		
zone_address_line3	varchar(500)	YES		
zone_city	varchar(40)	YES		
zone_country	varchar(15)	YES		
zone_district	varchar(30)	YES		
zone_name	varchar(60)	NO		
zone_spoc_contactnumber	varchar(10)	NO		
zone_spoc_email	varchar(50)	NO		
zone_spoc_name	varchar(50)	NO		
zone_state	varchar(20)	YES		
zone_zipcode	varchar(6)	YES		

--

SELECT *
FROM ap_masters.mst_zone
LIMIT 20;																
2	1017	Star Cement		2025-01-28 07:41:27	INACTIVE		2025-01-28 07:44:24	Kharghar	Sector 12	Navi Mumbai	Navi Mumbai	India	Thane	North	8889991010	nikhil1.r@autoplant.in	nikhil	Maharashtra	400701
2000	1000		NA	2020-04-02 14:00:08	1									Noth India	NA	NA	NA		
2001	1000		NA	2020-04-02 14:00:08	1									South India	NA	NA	NA		
2002	1000		NA	2020-04-02 14:00:08	1									East India	NA	NA	NA		
2003	1000		NA	2020-04-02 14:00:08	1									West India	NA	NA	NA		
2004	1001		NA	2020-04-02 14:00:09	1									Noth India	NA	NA	NA		
2005	1001		NA	2020-04-02 14:00:09	1									South India	NA	NA	NA		
2006	1001		NA	2020-04-02 14:00:09	1									East India	NA	NA	NA		
2007	1001		NA	2020-04-02 14:00:09	1									West India	NA	NA	NA		
2008	1002		NA	2020-07-09 05:39:02	1									India	NA	NA	NA		
2009	1002		NA	2020-07-09 05:39:02	1									South India	NA	NA	NA		
2010	1002		NA	2020-07-09 05:39:03	1									East India	NA	NA	NA		
2011	1002		NA	2020-07-09 05:39:03	1									North India	NA	NA	NA		
2012	1002		NA	2020-07-09 05:39:03	1									West India	NA	NA	NA		
2013	1004		NA	2020-09-22 09:33:52	1									North India	NA	NA	NA		
2014	1004		NA	2020-09-22 09:33:52	1									East India	NA	NA	NA		
2015	1004		NA	2020-09-22 09:33:52	1									West India	NA	NA	NA		
2016	1004		NA	2020-09-22 09:33:52	1									South India	NA	NA	NA		
2023	1006		NA	2021-11-15 06:03:46	1									West India	NA	NA	NA		
																		-----
DESCRIBE ap_masters.mst_region;															region_id	int	NO	PRI	
company_id	int	NO		
company_name	varchar(60)	NO		
created_by	varchar(30)	NO		
created_datetime	datetime	NO		
region_addressline1	varchar(500)	YES		
region_addressline2	varchar(500)	YES		
region_addressline3	varchar(500)	YES		
region_city	varchar(40)	YES		
region_country	varchar(20)	YES		
region_district	varchar(30)	YES		
region_name	varchar(60)	NO		
region_spoccontact	varchar(10)	YES		
region_spocemail	varchar(50)	YES		
region_spocname	varchar(50)	YES		
region_state	varchar(60)	YES		
region_status	varchar(10)	NO		
region_zipcode	int	YES		
updated_by	varchar(30)	YES		
updated_datetime	datetime	YES		
zone_id	int	NO		
zone_name	varchar(60)	NO		

---
SELECT *
FROM ap_masters.mst_region
LIMIT 20;

4043	1041	Auto_Novire		2025-04-21 12:19:03							Chandigarh					ACTIVE	0			2054	North
4044	1041	Auto_Novire		2025-04-21 12:19:03							Delhi					ACTIVE	0			2054	North
4045	1041	Auto_Novire		2025-04-21 12:19:03							Jammu & Kashmir					ACTIVE	0			2054	North
4046	1041	Auto_Novire		2025-04-21 12:19:03							Ladakh					ACTIVE	0			2054	North
4047	1041	Auto_Novire		2025-04-21 12:19:03							Arunachal Pradesh					ACTIVE	0			2055	East
4048	1041	Auto_Novire		2025-04-21 12:19:03							Assam					ACTIVE	0			2055	East
4049	1041	Auto_Novire		2025-04-21 12:19:03							Bihar					ACTIVE	0			2055	East
4050	1041	Auto_Novire		2025-04-21 12:19:03							Chhattisgarh					ACTIVE	0			2055	East
4051	1041	Auto_Novire		2025-04-21 12:19:03							Jharkhand					ACTIVE	0			2055	East
4052	1041	Auto_Novire		2025-04-21 12:19:03							Manipur					ACTIVE	0			2055	East
4053	1041	Auto_Novire		2025-04-21 12:19:03							Meghalaya					ACTIVE	0			2055	East
4054	1041	Auto_Novire		2025-04-21 12:19:03							Mizoram					ACTIVE	0			2055	East
4055	1041	Auto_Novire		2025-04-21 12:19:03							Nagaland					ACTIVE	0			2055	East
4056	1041	Auto_Novire		2025-04-21 12:19:03							Odisha					ACTIVE	0			2055	East
																												----
										
															DESCRIBE ap_masters.mst_vehicle;		


vehicle_no	varchar(255)	NO	PRI	
chasis_no	varchar(255)	YES		
company_id	int	YES		0
created_dt	datetime	YES	MUL	CURRENT_TIMESTAMP
device_id	varchar(255)	YES	MUL	
driver_name	varchar(255)	YES		
driver_id	int	YES		0
engine_no	varchar(255)	YES		
fitness_renewal_dt	date	YES		
fuel_type	varchar(255)	YES		
goods_pemit_validity_dt	date	YES		
gross_weight	varchar(255)	YES		
hazardous_material_license	varchar(255)	YES		
hierarchy_path	varchar(255)	YES	MUL	
insurance_company_name	varchar(255)	YES		
insurance_expiry_dt	datetime	YES		
insurance_no	varchar(255)	YES		
max_carry_capacity	int	YES		0
modified_by	int	YES		0
modified_dt	datetime	YES		
no_of_wheels	int	YES		0
optimal_carry_capacity	int	YES		0
plant_id	int	YES		0
plant_name	varchar(255)	YES		
preffered_destination	varchar(255)	YES		
primary_owner_mobile_no	varchar(255)	YES		
primary_owner_name	varchar(255)	YES		
puc_issued_dt	date	YES		
puc_validity_dt	date	YES		
pvc_issued_dt	date	YES		
pvc_validity_dt	date	YES		
road_tax_renewal_dt	date	YES		
secondary_owner_mobile_no	varchar(255)	YES		
secondary_owner_name	varchar(255)	YES		
vehicle_status	bit(1)	YES	MUL	
transporter_id	int	YES		
transporter_name	varchar(255)	YES		
unladen_weight	varchar(255)	YES		
vehicle_body_type	varchar(255)	YES		
vehicle_floor_type	varchar(255)	YES		
vehicle_height	int	YES		0
vehicle_length	int	YES		0
vehicle_make	varchar(255)	YES		
veh_manufactured_year	varchar(255)	YES		
vehicle_model	varchar(255)	YES		
vehicle_model_no	varchar(255)	YES		
vehicle_orgin	varchar(255)	YES		
vehicle_rc_no	varchar(255)	YES		
vehicle_type	varchar(255)	YES	MUL	
vehicle_width	int	YES		0
transporter_code	varchar(255)	YES		
analog_1	varchar(255)	YES		
analog_2	varchar(255)	YES		
analog_3	varchar(255)	YES		
analog_4	varchar(255)	YES		
billing_plant_code	varchar(255)	YES		
billing_plant_id	varchar(255)	YES		
billing_plant_name	varchar(255)	YES		
billing_transporter_code	varchar(255)	YES		
billing_transporter_id	varchar(255)	YES		
billing_transporter_name	varchar(255)	YES		
device_removed_by	varchar(255)	YES		
device_removed_dt	datetime	YES		
digital_1	varchar(255)	YES		
digital_2	varchar(255)	YES		
first_installed_by	varchar(255)	YES		
first_installed_company_id	varchar(255)	YES		
first_installed_dt	datetime	YES		
latest_installation_company_id	varchar(255)	YES		
latest_installation_dt	datetime	YES		
latest_installed_by	varchar(255)	YES		
maintenance	varchar(255)	YES	MUL	
reason_code	varchar(255)	YES		
remarks	varchar(255)	YES		
vendor	varchar(255)	YES	MUL	
plant_code	varchar(10)	YES		
deployment_status	varchar(50)	YES		
reruncompanyid	varchar(30)	YES		
vehicle_data_source	varchar(50)	NO		CURRENT
installation_remark	varchar(255)	YES		
installation_subremark	varchar(255)	YES		
driver_phone_number	varchar(15)	YES		
device_installation_date	datetime	YES		
device_latest_installation_date	datetime	YES		
vehicle_mapping_date	datetime	YES		
vehicle_latest_mapping_date	datetime	YES		
record_created_date	datetime	YES		
record_updated_date	datetime	YES		
deployment_date	datetime	YES		
previous_vehicle_no	varchar(50)	YES		
first_vehicle_no	varchar(50)	YES		
tm_direction	varchar(20)	YES		
unloading_sensor	tinyint(1)	YES		0															


--


SELECT *
FROM ap_masters.mst_vehicle
LIMIT 20;



  MH18BG8842		0	2025-08-31 00:28:58	MH18BG8842		0							1047				30	0		0	0	4267	TALOJA PLANT											1	14660	EVERYWHERE TRANSPORT				0	0							3RD PARTY	0	606724					TALO1	4267	TALOJA PLANT	606724	14660	EVERYWHERE TRANSPORT					DFPCL_ADMIN	1047	2025-08-28 17:57:55	1047	2025-08-31 00:28:50	NA		NO TRIP > 15 DAYS			TALO1	UNDEPLOYED		CURRENT										2025-10-14 10:10:55				0
860103061672094		0	2026-04-08 00:12:23	860103061672094		0							1034				30	0		0	0	3694	ZUARI_SPM											1	12194	SRI SATYADEVA TRANSPORT LLP				0	0							DEDICATED	0	4100901165					I008	3694	ZUARI_SPM	4100901165	12194	SRI SATYADEVA TRANSPORT LLP					HARSH RAGHAV	1034	2026-01-21 13:15:29	1034	2026-04-08 00:12:23	NA		NO TRIP > 15 DAYS			I008	UNDEPLOYED		CURRENT	Re-Mapping	Same Device		2026-01-21 13:15:28	2026-01-21 13:15:28	2026-01-21 13:15:28	2026-01-21 13:15:28	2026-01-21 13:15:28	2026-04-08 00:12:24	2026-04-08 00:12:24	860103061672094	860103061672094		0
AP02TA2569		0	2025-12-17 10:54:58	0869925073271551		0							1015				10	0		0	0	3038	KADAPPA											1	7216	SRI LAKSHMI VENKATESWARA TRANSPORT				0	0							DEDICATED	0	0000901225					1000	3038	KADAPPA	0000901225	7216	SRI LAKSHMI VENKATESWARA TRANSPORT					VICAT_KADAPA_SERVICE	1015	2025-12-17 10:54:59	NA							1000	DEPLOYED		CURRENT	New Installation	New Device		2025-12-17 10:54:59	2025-12-17 10:54:59	2025-12-17 10:54:59	2025-12-17 10:54:59	2025-12-17 10:54:59		2025-12-17 10:54:59		AP02TA2569		0
AP02TA6589		0	2026-06-24 00:14:28	0867440061714648		0							1010				0	0		0	0	3628	GGU											1	7646	MK ENTERPRISES				0	0							DEDICATED	0	0002411017					6991	3628	GGU	0002411017	7646	MK ENTERPRISES					NA	1010	2024-10-30 10:51:01	1010	2025-11-26 01:54:15	UTCL_SERVICE		NO TRIP > 15 DAYS				UNDEPLOYED		CURRENT	Re-Installation	Replacement Device			2026-06-24 00:14:28				2026-06-24 00:14:28	2026-06-24 00:14:29	AP02TA6589	AP02TA6589	NA	0
AP02TC6699		0	2026-05-10 15:48:43	0869925073311035		0							1015				10	0		0	0	3038	KADAPPA											1	7216	SRI LAKSHMI VENKATESWARA TRANSPORT				0	0	ASHOK LEYLAND LTD	1/2016	3718IL TYRE 10.00 R 20: 16 PR				DEDICATED	0	0000901225					1000	3038	KADAPPA	0000901225	7216	SRI LAKSHMI VENKATESWARA TRANSPORT					VICAT_KADAPA_SERVICE	1015	2026-01-02 11:09:49	1015	2026-04-05 00:12:57	INTEGRATION_SERVICE		NO TRIP > 15 DAYS			1000	DEPLOYED		CURRENT	Re-Mapping	Same Device		2026-01-02 11:09:49	2026-01-02 11:09:49	2026-01-02 11:09:49	2026-01-02 11:09:49	2026-01-02 11:09:49	2026-05-10 15:48:43	2026-05-10 15:48:43	AP02TC6699	AP02TC6699	NA	0
AP02TE5495		0	2025-07-10 20:10:03	862843047226857		0							1034				0	0		0	0	3693	ZUARI_YERRAGUNTLA											1	12135	MARUTHI TRANSPORT				0	0							DEDICATED	0	4100900998	NA	NA	NA	NA	0	3693	ZUARI_YERRAGUNTLA	4100900998	12135	MARUTHI TRANSPORT			NA	NA	NA	1034	2025-01-10 11:32:56	1034	2025-07-10 20:10:03	NA		0				UNDEPLOYED		CURRENT										2025-10-14 10:10:55				0
AP02TH5009		0	2026-04-21 00:14:07	0869925072767195		0							1015				10	0		0	0	3038	KADAPPA											1	14051	CENTRAL WAREHOUSING CORPORATION				0	0	TATA MOTORS LTD	12/2018	ULTRA 1518 T 5L/45WB BS IV				DEDICATED	0	0000901688					1000	3038	KADAPPA	0000901688	14051	CENTRAL WAREHOUSING CORPORATION					VICAT_KADAPA_SERVICE	1015	2025-12-05 06:06:37	1015	2026-02-20 00:20:28	INTEGRATION_SERVICE		NO TRIP > 15 DAYS			1000	UNDEPLOYED		CURRENT	Re-Mapping	Same Device		2025-12-05 06:06:36	2025-12-05 06:06:36	2025-12-05 06:06:36	2025-12-05 06:06:36	2025-12-05 06:06:36	2026-04-21 00:14:07	2026-04-21 00:14:07	AP02TH5009	AP02TH5009	NA	0
AP02TH5569		0	2025-11-23 03:05:27	862843049369226		0							1034				0	0		0	0	3693	ZUARI_YERRAGUNTLA											1	12228	JMS TRANSPORTER				0	0							DEDICATED	0	NA	NA	NA	NA	NA	0	3693	ZUARI_YERRAGUNTLA	4100900998	12135	MARUTHI TRANSPORT			NA	NA	NA	1034	2025-01-10 11:32:35	1034	2025-11-23 03:05:08	NA		NO TRIP > 15 DAYS				UNDEPLOYED		CURRENT	Re-Mapping	Same Device							2025-11-23 03:05:18	2025-11-23 03:05:28	AP02TH5569	AP02TH5569		0
AP02X8378		0	2025-07-10 20:10:03	862843043299536		0							1034				0	0		0	0	3692	HCIL_AMMA											1	12113	NATIONAL ROADWAYS				0	0							DEDICATED	0	4100901058	NA	NA	NA	NA	0	3692	HCIL_AMMA	4100901058	12113	NATIONAL ROADLINES			NA	NA	NA	1034	2025-01-10 11:33:13	1034	2025-07-10 20:10:03	NA		0				UNDEPLOYED		CURRENT										2025-10-14 10:10:55				0
AP03TA3627		0	2026-04-06 15:18:42	0869925073687863		0							1015				10	0		0	0	3038	KADAPPA											1	16006	S R LOGISTICS				0	0	TATA MOTORS LTD	1/2011	LPT 3118 TC BSIII (8X2)(COWL)				DEDICATED	0	0000901457					1000	3038	KADAPPA	901457	15987	SR LOGISTICS					VICAT_KADAPA_SERVICE	1015	2026-02-26 09:45:06	1015	2026-02-26 11:17:11	INTEGRATION_SERVICE					1000	DEPLOYED		CURRENT	New Installation	New Device		2026-02-26 09:45:04	2026-02-26 09:45:04	2026-02-26 09:45:04	2026-02-26 09:45:04	2026-02-26 09:45:04	2026-04-06 15:18:42	2026-02-26 09:45:06	AP03TA3627	AP03TA3627		0
AP03TC0959		0	2025-07-10 19:50:45	AP03TC0959		0							1009				12	0		0	0	3127	KESORAM WORKS											1	12042	SKLS LORRY SERVICESS				0	0	TATA	2002	TRUCK				3RD PARTY	0	S07862	NA	NA	NA	NA	0	3027	SDM-201	V01018	7158	VAISHNAVI TRANSPORT CORPORATION			NA	NA	NA	1009	2024-03-19 05:44:13	1009	2025-07-10 19:50:45	NA		0		WHEELSEYE		DEPLOYED		CURRENT										2025-10-14 10:10:55				0
AP03TE9892		0	2025-12-25 00:16:03	0359688090237743		0							1034				0	0		0	0	3693	ZUARI_YERRAGUNTLA											1	12228	JMS TRANSPORTER				0	0							DEDICATED	0	NA	NA	NA	NA	NA	0	3693	ZUARI_YERRAGUNTLA	4100900977	12133	AMMAYAPPER ROADWAYS			NA	NA	NA	1034	2025-01-10 11:32:52	1034	2025-11-15 11:22:48	NA		NO TRIP > 15 DAYS			I007	UNDEPLOYED		CURRENT	Re-Mapping	Same Device							2025-12-25 00:16:03	2025-12-25 00:16:03	AP03TE9892	AP03TE9892		0
AP03TE9893		0	2025-07-10 20:10:03	0359688090243048		0							1034				0	0		0	0	3693	ZUARI_YERRAGUNTLA											1	12133	AMMAYAPPER ROADWAYS PRIVATE LIMITED				0	0							DEDICATED	0	4100900977	NA	NA	NA	NA	0	3693	ZUARI_YERRAGUNTLA	4100900977	12133	AMMAYAPPER ROADWAYS			NA	NA	NA	1034	2025-01-10 11:33:01	1034	2025-07-10 20:10:03	NA		0				UNDEPLOYED		CURRENT										2025-10-14 10:10:55				0
AP03TE9894		0	2025-12-24 00:19:23	862843049354491		0							1034				0	0		0	0	3693	ZUARI_YERRAGUNTLA											1	12228	JMS TRANSPORTER				0	0							DEDICATED	0	NA	NA	NA	NA	NA	0	3693	ZUARI_YERRAGUNTLA	4100900977	12133	AMMAYAPPER ROADWAYS			NA	NA	NA	1034	2025-01-10 11:32:18	1034	2025-11-13 05:48:24	NA		NO TRIP > 15 DAYS			I007	UNDEPLOYED		CURRENT	Re-Mapping	Same Device							2025-12-24 00:19:23	2025-12-24 00:19:23	AP03TE9894	AP03TE9894		0
AP03TE9895		0	2025-12-26 00:33:12	0359688090249904		0							1034				0	0		0	0	3693	ZUARI_YERRAGUNTLA											1	12228	JMS TRANSPORTER				0	0							DEDICATED	0	NA	NA	NA	NA	NA	0	3693	ZUARI_YERRAGUNTLA	4100900977	12133	AMMAYAPPER ROADWAYS			NA	NA	NA	1034	2025-01-10 11:32:05	1034	2025-11-15 11:23:56	NA		NO TRIP > 15 DAYS			I007	UNDEPLOYED		CURRENT	Re-Mapping	Same Device							2025-12-26 00:33:11	2025-12-26 00:33:12	AP03TE9895	AP03TE9895		0
AP03TE9901		0	2025-10-08 00:33:57	0359688090241505		0							1034				0	0		0	0	3693	ZUARI_YERRAGUNTLA											1	12228	JMS TRANSPORTER				0	0							DEDICATED	0	NA	NA	NA	NA	NA	0	3693	ZUARI_YERRAGUNTLA	4100900977	12133	AMMAYAPPER ROADWAYS			NA	NA	NA	1034	2025-01-10 11:31:52	1034	2025-10-08 00:33:48	NA		NO TRIP > 15 DAYS				UNDEPLOYED		CURRENT	Re-Mapping	Same Device							2025-10-08 00:33:57	2025-10-14 10:10:55				0
AP03TE9902		0	2025-12-21 00:19:18	0359688090244467		0							1034				0	0		0	0	3693	ZUARI_YERRAGUNTLA											1	12228	JMS TRANSPORTER				0	0							DEDICATED	0	NA	NA	NA	NA	NA	0	3693	ZUARI_YERRAGUNTLA	4100900977	12133	AMMAYAPPER ROADWAYS			NA	NA	NA	1034	2025-01-10 11:32:50	1034	2025-12-01 02:59:53	INTEGRATION_SERVICE		NO TRIP > 15 DAYS			I007	UNDEPLOYED		CURRENT	Re-Mapping	Same Device							2025-12-21 00:19:17	2025-12-21 00:19:18	AP03TE9902	AP03TE9902		0
AP03TE9904		0	2025-12-21 00:19:19	862843049386436		0							1034				0	0		0	0	3693	ZUARI_YERRAGUNTLA											1	12228	JMS TRANSPORTER				0	0							DEDICATED	0	NA	NA	NA	NA	NA	0	3693	ZUARI_YERRAGUNTLA	4100900977	12133	AMMAYAPPER ROADWAYS			NA	NA	NA	1034	2025-01-10 11:32:00	1034	2025-11-15 11:27:43	INTEGRATION_SERVICE		NO TRIP > 15 DAYS			I007	UNDEPLOYED		CURRENT	Re-Mapping	Same Device							2025-12-21 00:19:18	2025-12-21 00:19:20	AP03TE9904	AP03TE9904		0
AP03TE9906		0	2025-12-24 00:19:24	862491073560771		0							1034				0	0		0	0	3693	ZUARI_YERRAGUNTLA											1	12228	JMS TRANSPORTER				0	0							DEDICATED	0	NA	NA	NA	NA	NA	0	3693	ZUARI_YERRAGUNTLA	4100900977	12133	AMMAYAPPER ROADWAYS			NA	NA	NA	1034	2025-01-10 11:32:16	1034	2025-11-15 11:27:21	NA		NO TRIP > 15 DAYS			I007	UNDEPLOYED		CURRENT	Re-Mapping	Same Device							2025-12-24 00:19:24	2025-12-24 00:19:24	AP03TE9906	AP03TE9906		0


--

DESCRIBE ap_masters.mst_transporter;

transporter_id	bigint	NO	PRI	
company_id	int	NO		
createdby	varchar(100)	YES		
created_datetime	datetime	YES		
plant_id	int	NO		
spoc_email	varchar(45)	YES		
spoc_mobile	varchar(10)	YES		
spoc_name	varchar(45)	YES		
status	varchar(10)	NO		
transporter_addressline1	varchar(500)	YES		
transporter_addressline2	varchar(500)	YES		
transporter_addressline3	varchar(500)	YES		
transporter_city	varchar(100)	YES		
transporter_code	varchar(45)	NO		
transporter_country	varchar(100)	YES		
transporter_district	varchar(100)	YES		
transporter_location	varchar(200)	YES		
transporter_name	varchar(60)	NO		
transporter_pincode	varchar(100)	YES		
transporter_relog_avaibility	varchar(100)	YES		
transporter_state	varchar(100)	YES		
transporter_zone	varchar(200)	YES		
updatedby	varchar(100)	YES		
updated_datetime	datetime	YES		
company_name	varchar(60)	YES		
																																																													
---
SELECT *
FROM ap_masters.mst_transporter
LIMIT 20;

1	1001		2021-08-24 11:04:41	1	abcd@gmail.com	1234567891	abcd	ACTIVE	Bengaluru				5066				Durga transporter							
6200	1006		2021-08-24 11:04:43	3017		9116610051	Tarak Logistics LLP	ACTIVE	Tarak Logistics LLP				107039				Tarak Logistics LLP							
6201	1006		2021-08-24 11:04:43	3017		9694770570	Shree Astoliya Transport Company	ACTIVE	Shree Astoliya Transport Company				112840				Shree Astoliya Transport Company							
6202	1006		2021-08-24 11:04:44	3017		7023567700	NEW RADHIKA TRANSPORT COMPANY	ACTIVE	NEW RADHIKA TRANSPORT COMPANY				112850				NEW RADHIKA TRANSPORT COMPANY							
6203	1006		2021-08-24 11:04:42	3017		8769842098	Shree Patel Transport	ACTIVE	Shree Patel Transport				101611				Shree Patel Transport							
6204	1006		2021-08-24 11:04:45	3020	bmrmpoint@gmail.com	7496980298	BMR MAVEN POINT PRIVATE LIMITED	ACTIVE	BMR MAVEN POINT PRIVATE LIMITED				114287				BMR MAVEN POINT PRIVATE LIMITED							
6205	1006		2021-08-24 11:04:46	3020	anilbuildtech73@gmail.com	9855462159	Anil Buildtech	ACTIVE	Anil Buildtech				114292				Anil Buildtech							
6206	1006		2021-08-24 11:04:46	3020	g.k.contractor97@gmail.com	9991091010	Gulshan Kumar Contractor	ACTIVE	Gulshan Kumar Contractor				114293				Gulshan Kumar Contractor							
6207	1006		2021-08-24 11:04:48	3020	ptcjkl@gmail.com	9992588383	PREET TRANSPORT CO.	ACTIVE	PREET TRANSPORT CO.				114296				PREET TRANSPORT CO.							
6208	1006		2021-08-24 11:04:48	3020	shreeram466499@gmail.com	8059444552	SHREE RAM BUILDERS	ACTIVE	SHREE RAM BUILDERS				114297				SHREE RAM BUILDERS							
6209	1006		2021-08-24 11:04:49	3020	jagdeep4@gmail.com	9991964860	HEMKUND LOGISTICS PRIVATE LIMITED	ACTIVE	HEMKUND LOGISTICS PRIVATE LIMITED				114298				HEMKUND LOGISTICS PRIVATE LIMITED							
6210	1006		2021-08-24 11:04:50	3020	ajayyadavsirohi@gmail.com	9812228525	SIROHI TYRES & LOGISTIC	ACTIVE	SIROHI TYRES & LOGISTIC				114300				SIROHI TYRES & LOGISTIC							
6211	1006		2021-08-24 11:04:52	3020	tayal_traders@rediffmail.com	8683019292	SHRI SHYAM TRANSPORT CO.	ACTIVE	SHRI SHYAM TRANSPORT CO.				114305				SHRI SHYAM TRANSPORT CO.							
6212	1006		2021-08-24 11:04:52	3020	ranatransport222@gmail.com	9654544009	RANA TRANSPORT	ACTIVE	RANA TRANSPORT				114307				RANA TRANSPORT							
6213	1006		2021-08-24 11:04:53	3020	shrihemkuntlogistics81@gmail.com	9728393222	SHRI HEMKUNT LOGISTICS	ACTIVE	SHRI HEMKUNT LOGISTICS				114308				SHRI HEMKUNT LOGISTICS							
6214	1006		2021-08-24 11:04:56	3020	jeetroadline@gmail.com	7700003708	JEET ROADLINES	ACTIVE	JEET ROADLINES				114331				JEET ROADLINES																																																																																																																												