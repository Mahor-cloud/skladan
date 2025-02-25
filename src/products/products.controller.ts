import {
	Body,
	Controller,
	Delete,
	Get,
	Param,
	Post,
	Put,
	UsePipes,
} from '@nestjs/common'
import { Auth } from 'src/auth/decorators/auth.decorator'
import { CurrentUser } from 'src/auth/decorators/current-user.decorator'
import { UserModel } from 'src/auth/user.model'
import { IdValidationPipe } from 'src/pipes/id.validation.pipe'
import { CreateProductDto } from './dto/create-product.dto'
import { UpdateProductDto } from './dto/update-product.dto'
import { ProductsService } from './products.service'

@Controller('products')
export class ProductsController {
	constructor(private readonly productsService: ProductsService) {}

	@Post()
	@Auth('admin', ['create_product'])
	create(
		@Body() createProductDto: CreateProductDto,
		@CurrentUser() currentUser: UserModel
	) {
		return this.productsService.createProduct(createProductDto, currentUser)
	}

	@Get()
	@Auth('user', ['view_products'])
	findAll() {
		return this.productsService.findAll()
	}

	@Get(':id')
	@Auth('user', ['view_products'])
	@UsePipes(IdValidationPipe)
	findOne(@Param('id') id: string) {
		return this.productsService.findOne(id)
	}

	@Put(':id')
	@Auth('admin', ['edit_products'])
	@UsePipes(IdValidationPipe)
	update(
		@Param('id') id: string,
		@Body() updateProductDto: UpdateProductDto,
		@CurrentUser() currentUser: UserModel
	) {
		return this.productsService.update(id, updateProductDto, currentUser)
	}

	@Delete(':id')
	@Auth('admin', ['delete_products'])
	@UsePipes(IdValidationPipe)
	remove(@Param('id') id: string, @CurrentUser() currentUser: UserModel) {
		return this.productsService.remove(id, currentUser)
	}
}
