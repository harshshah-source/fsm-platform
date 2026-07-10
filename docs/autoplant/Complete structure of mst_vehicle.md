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